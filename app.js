/* =========================
   모두의 예약 시스템 (완성본)
   - Firestore 실시간 반영
   - 월 달력 상태(없음/가능/마감)
   - 학생/학부모 폼
   - 1인 1회 제한 (reservations/{uid})
   - 자유 취소
   - 교사용 엑셀 다운로드
========================= */

/* ✅ Firebase 설정: 본인 값으로 교체 */
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
};
firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

/* 공통 상태 */
let PAGE = null; // "teacher" | "apply"
let teacherCode = null;

let viewYear = null;
let viewMonth = null; // 0-11
let selectedDateStr = null; // YYYY-MM-DD

// 월 구독 해제 함수
let unsubMonth = null;
let unsubMyRes = null;
let unsubDay = null;

// 월 슬롯 캐시: slotId -> data
let monthSlots = new Map();

/* ---------- 유틸 ---------- */
function pad2(n){ return String(n).padStart(2,"0"); }

function ymd(d){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function monthKey(y,m0){
  return `${y}-${pad2(m0+1)}`;
}

function monthRange(y,m0){
  const start = new Date(y, m0, 1, 0, 0, 0, 0);
  const end = new Date(y, m0+1, 1, 0, 0, 0, 0);
  return { start, end };
}

function toTimestampLocal(ymdStr, timeStr){
  // 로컬 시간 기준 Date 생성 후 Timestamp
  const [Y,M,D] = ymdStr.split("-").map(Number);
  const [hh,mm] = timeStr.split(":").map(Number);
  const dt = new Date(Y, M-1, D, hh, mm, 0, 0);
  return firebase.firestore.Timestamp.fromDate(dt);
}

function maskPhone(p){
  if(!p) return "";
  const digits = p.replace(/\D/g,"");
  if(digits.length < 8) return p;
  // 01012345678 -> 010-****-5678
  const tail = digits.slice(-4);
  const head = digits.slice(0,3);
  return `${head}-****-${tail}`;
}

function el(id){ return document.getElementById(id); }

function setText(id, txt){
  const e = el(id);
  if(e) e.textContent = txt;
}

function setHTML(id, html){
  const e = el(id);
  if(e) e.innerHTML = html;
}

/* ---------- 교사코드 생성/조회 ---------- */
function randomCode4(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s="";
  for(let i=0;i<4;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}

async function getOrCreateTeacherCode(user){
  // teachers 컬렉션에서 uid 매칭 doc 찾기
  const q = await db.collection("teachers").where("uid","==",user.uid).limit(1).get();
  if(!q.empty){
    return q.docs[0].id; // docId = teacherCode
  }

  // 없으면 새로 생성 (충돌 방지)
  for(let attempt=0; attempt<10; attempt++){
    const code = "TCH-" + randomCode4();
    const ref = db.collection("teachers").doc(code);
    const snap = await ref.get();
    if(!snap.exists){
      await ref.set({
        uid: user.uid,
        email: user.email || "",
        name: user.displayName || "",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return code;
    }
  }
  throw new Error("교사코드 생성 실패(재시도 필요)");
}

/* ---------- 공통: 월 달력 렌더 ---------- */
function buildCalendarCells(y, m0){
  const first = new Date(y, m0, 1);
  const firstDow = first.getDay(); // 0=일
  const daysInMonth = new Date(y, m0+1, 0).getDate();

  // 달력 42칸(6주) 구성
  const cells = [];
  for(let i=0;i<firstDow;i++){
    cells.push({ type:"blank" });
  }
  for(let d=1; d<=daysInMonth; d++){
    const dt = new Date(y, m0, d);
    cells.push({ type:"day", date: ymd(dt), day: d });
  }
  while(cells.length % 7 !== 0) cells.push({ type:"blank" });
  while(cells.length < 42) cells.push({ type:"blank" });
  return cells;
}

function computeDayStatus(dateStr){
  // monthSlots에서 dateStr 일치 슬롯 집계
  let total=0, open=0, booked=0;
  for(const [,v] of monthSlots){
    if(v.date === dateStr){
      total++;
      if(v.status === "open") open++;
      if(v.status === "booked") booked++;
    }
  }
  if(total === 0) return { status:"none", dot:"none", label:"슬롯 없음" };
  if(open > 0) return { status:"open", dot:"open", label:`가능 ${open}` };
  return { status:"full", dot:"full", label:`마감` };
}

function renderMonth(){
  const cal = el("calendar");
  if(!cal) return;

  setText("monthTitle", `${viewYear}년 ${viewMonth+1}월`);
  cal.innerHTML = "";

  const cells = buildCalendarCells(viewYear, viewMonth);
  for(const c of cells){
    const div = document.createElement("div");
    if(c.type === "blank"){
      div.className = "day disabled";
      div.innerHTML = `<div class="date">&nbsp;</div>`;
      cal.appendChild(div);
      continue;
    }

    const st = computeDayStatus(c.date);
    div.className = `day ${st.status}` + (selectedDateStr===c.date ? " selected":"");
    div.innerHTML = `
      <div class="badge-row">
        <div class="date">${c.day}</div>
        <div class="dot ${st.dot}" title="${st.label}"></div>
      </div>
      <div class="muted small">${st.label}</div>
    `;

    div.onclick = () => {
      selectedDateStr = c.date;
      renderMonth();
      onSelectDate(c.date);
    };
    cal.appendChild(div);
  }
}

/* ---------- 월 데이터 실시간 구독 ---------- */
function subscribeMonth(){
  if(unsubMonth) unsubMonth();
  monthSlots.clear();

  const { start, end } = monthRange(viewYear, viewMonth);
  // ✅ teacherCode equality + startTs range => 인덱스 필요할 수 있음(콘솔 안내대로 생성)
  const q = db.collection("slots")
    .where("teacherCode","==",teacherCode)
    .where("startTs",">=", firebase.firestore.Timestamp.fromDate(start))
    .where("startTs","<",  firebase.firestore.Timestamp.fromDate(end));

  unsubMonth = q.onSnapshot((snap)=>{
    snap.docChanges().forEach(ch=>{
      if(ch.type === "removed"){
        monthSlots.delete(ch.doc.id);
      } else {
        monthSlots.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
      }
    });
    renderMonth();

    // 선택된 날짜가 있으면 그 날 슬롯도 다시 렌더
    if(selectedDateStr){
      renderDaySlots(selectedDateStr);
      if(PAGE==="teacher"){
        renderBookingTable(selectedDateStr);
      }
    }
  }, (err)=>{
    console.error(err);
    alert("Firestore 인덱스가 필요할 수 있습니다. 콘솔의 에러 메시지에 나온 링크로 인덱스를 생성하세요.");
  });
}

/* ---------- 날짜 선택 처리 ---------- */
function onSelectDate(dateStr){
  setText("selectedDateTitle", `📅 ${dateStr}`);

  if(PAGE==="teacher"){
    // 시간 선택 UI 표시
    buildTimePicker();
    renderDaySlots(dateStr) ;
    renderBookingTable(dateStr);
  } else {
    renderDaySlots(dateStr);
  }
}

/* ---------- 시간 선택(교사용 슬롯 열기) ---------- */
function teacherDefaultTimes(){
  // 학교 상담 시간대 예시 (필요하면 수정)
  return ["09:00","10:00","11:00","13:00","14:00","15:00","16:00","17:00"];
}

function buildTimePicker(){
  const tp = el("timePicker");
  if(!tp) return;
  tp.innerHTML = "";
  const times = teacherDefaultTimes();

  times.forEach(t=>{
    const chip = document.createElement("div");
    chip.className = "time-chip";
    chip.dataset.time = t;
    chip.innerHTML = `<span class="t">${t}</span><span class="s">선택</span>`;
    chip.onclick = ()=>{
      chip.classList.toggle("selected");
      chip.querySelector(".s").textContent = chip.classList.contains("selected") ? "선택됨" : "선택";
    };
    tp.appendChild(chip);
  });
}

async function openSelectedSlots(){
  if(!selectedDateStr) return alert("먼저 날짜를 선택하세요.");
  const tp = el("timePicker");
  if(!tp) return;

  const selected = Array.from(tp.querySelectorAll(".time-chip.selected"))
    .map(x=>x.dataset.time);

  if(selected.length === 0) return alert("열 시간을 1개 이상 선택하세요.");

  // 동일 슬롯 중복 생성 방지: 이미 있는 슬롯 체크
  const batch = db.batch();
  let created = 0;

  // 기존 슬롯(선택 날짜) 목록
  const existing = [];
  for(const [,v] of monthSlots){
    if(v.date === selectedDateStr) existing.push(v.time);
  }
  const existingSet = new Set(existing);

  selected.forEach(t=>{
    if(existingSet.has(t)) return;
    const ref = db.collection("slots").doc();
    batch.set(ref, {
      teacherCode,
      date: selectedDateStr,
      time: t,
      startTs: toTimestampLocal(selectedDateStr, t),
      status: "open",
      bookedByUid: null,
      bookedAt: null,
      bookedType: null,
      bookedName: null,
      bookedPhone: null,
      bookedStudentNo: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    created++;
  });

  if(created === 0) return alert("새로 열 슬롯이 없습니다. (이미 모두 열려 있음)");

  await batch.commit();
  alert(`슬롯 ${created}개를 열었습니다.`);
}

/* ---------- 날짜 슬롯 렌더 ---------- */
function renderDaySlots(dateStr){
  const container = el("slots");
  if(!container) return;
  container.innerHTML = "";

  // 해당 날짜 슬롯만 정렬
  const list = [];
  for(const [,v] of monthSlots){
    if(v.date === dateStr) list.push(v);
  }
  list.sort((a,b)=> (a.time||"").localeCompare(b.time||""));

  if(list.length === 0){
    container.innerHTML = `<div class="muted">해당 날짜에 열린 상담 시간이 없습니다.</div>`;
    return;
  }

  list.forEach(v=>{
    const div = document.createElement("div");
    const isOpen = (v.status === "open");
    div.className = "slot " + (isOpen ? "open" : "booked");
    div.innerHTML = `
      <div>${v.time}</div>
      <div class="mini">${isOpen ? "예약 가능" : "예약됨"}</div>
    `;

    if(PAGE==="apply" && isOpen){
      div.onclick = ()=> openReserveModal(v);
    }
    if(PAGE==="teacher"){
      // 교사용은 클릭 행동 없음 (현황은 아래 테이블에서)
    }
    container.appendChild(div);
  });
}

/* ---------- 교사용: 예약 현황 테이블 ---------- */
function renderBookingTable(dateStr){
  const tb = el("bookingTbody");
  if(!tb) return;
  const list = [];
  for(const [,v] of monthSlots){
    if(v.date === dateStr && v.status === "booked"){
      list.push(v);
    }
  }
  list.sort((a,b)=> (a.time||"").localeCompare(b.time||""));

  if(list.length === 0){
    tb.innerHTML = `<tr><td colspan="6" class="muted center">예약된 내역이 없습니다.</td></tr>`;
    return;
  }

  tb.innerHTML = list.map(v=>{
    const type = v.bookedType === "parent" ? "학부모" : "학생";
    const name = v.bookedName || "";
    const noOrChild = (v.bookedType==="student") ? (v.bookedStudentNo||"") : (v.bookedStudentNo||"");
    const phone = maskPhone(v.bookedPhone || "");
    return `
      <tr>
        <td>${v.date}</td>
        <td>${v.time}</td>
        <td>${type}</td>
        <td>${name}</td>
        <td>${noOrChild}</td>
        <td>${phone}</td>
      </tr>
    `;
  }).join("");
}

/* ---------- 교사용: 엑셀 다운로드 ---------- */
function downloadExcelTeacher(){
  // 현재 월 전체 booked 슬롯 다운로드
  const rows = [];
  for(const [,v] of monthSlots){
    if(v.status === "booked"){
      rows.push({
        날짜: v.date,
        시간: v.time,
        구분: (v.bookedType === "parent" ? "학부모" : "학생"),
        이름: v.bookedName || "",
        "학번/자녀": v.bookedStudentNo || "",
        연락처: maskPhone(v.bookedPhone || ""),
      });
    }
  }
  rows.sort((a,b)=> (a.날짜+a.시간).localeCompare(b.날짜+b.시간));

  if(rows.length === 0){
    alert("예약된 상담현황이 없습니다.");
    return;
  }

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "상담현황");
  XLSX.writeFile(wb, `상담현황_${monthKey(viewYear,viewMonth)}.xlsx`);
}

/* ---------- 학생/학부모: 1인 1회 예약(reservations/{uid}) ---------- */
async function getMyReservation(uid){
  const ref = db.collection("reservations").doc(uid);
  const snap = await ref.get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

function subscribeMyReservation(){
  const user = auth.currentUser;
  if(!user) return;

  if(unsubMyRes) unsubMyRes();
  unsubMyRes = db.collection("reservations").doc(user.uid).onSnapshot((snap)=>{
    renderMyReservation(snap.exists ? { id:snap.id, ...snap.data() } : null);
  });
}

function renderMyReservation(res){
  const box = el("myReservationBox");
  if(!box) return;

  if(!res){
    box.innerHTML = `<div class="muted">현재 예약이 없습니다. 달력에서 가능한 시간을 선택해 신청하세요.</div>`;
    return;
  }

  box.innerHTML = `
    <div class="kv">
      <div class="k">교사코드</div><div class="v">${res.teacherCode}</div>
      <div class="k">예약일</div><div class="v">${res.date}</div>
      <div class="k">예약시간</div><div class="v">${res.time}</div>
    </div>
    <div class="my-actions">
      <button class="btn" id="btnCancelMine">예약 취소</button>
    </div>
  `;

  el("btnCancelMine").onclick = ()=> cancelMyReservation(res);
}

/* ---------- 학생/학부모: 예약 모달 ---------- */
let pendingSlot = null;

function openReserveModal(slot){
  pendingSlot = slot;
  const modal = el("modal");
  const title = el("modalTitle");
  const info = el("modalInfo");
  if(!modal) return;

  title.textContent = `예약 신청 · ${slot.date} ${slot.time}`;
  info.textContent = `교사코드: ${teacherCode} / 선택 시간: ${slot.time}`;

  // reset
  el("studentNo").value = "";
  el("studentName").value = "";
  el("studentPhone").value = "";
  el("childName").value = "";
  el("parentPhone").value = "";

  modal.classList.add("show");
}

function closeModal(){
  const modal = el("modal");
  if(modal) modal.classList.remove("show");
  pendingSlot = null;
}

function bindModalUI(){
  const modalClose = el("modalClose");
  const btnSubmit = el("btnSubmit");
  if(modalClose) modalClose.onclick = closeModal;

  // type switch
  const radios = document.querySelectorAll('input[name="type"]');
  radios.forEach(r=>{
    r.onchange = ()=>{
      const val = document.querySelector('input[name="type"]:checked').value;
      el("studentFields").style.display = (val==="student") ? "block" : "none";
      el("parentFields").style.display  = (val==="parent") ? "block" : "none";
    };
  });

  if(btnSubmit){
    btnSubmit.onclick = async ()=>{
      if(!pendingSlot) return;

      const user = auth.currentUser;
      if(!user) return alert("로그인이 필요합니다.");

      // 1인 1회 체크는 트랜잭션에서 최종 보장
      const type = document.querySelector('input[name="type"]:checked').value;

      let payload = {};
      if(type === "student"){
        const studentNo = el("studentNo").value.trim();
        const name = el("studentName").value.trim();
        const phone = el("studentPhone").value.trim();
        if(!studentNo || !name || !phone) return alert("학번/이름/전화번호를 모두 입력하세요.");
        payload = { bookedType:"student", bookedStudentNo:studentNo, bookedName:name, bookedPhone:phone };
      } else {
        const child = el("childName").value.trim();
        const phone = el("parentPhone").value.trim();
        if(!child || !phone) return alert("자녀 이름/학부모 전화번호를 입력하세요.");
        payload = { bookedType:"parent", bookedStudentNo:child, bookedName:child, bookedPhone:phone };
      }

      try{
        await reserveSlotTransactional(pendingSlot.id, payload);
        closeModal();
        alert("예약이 완료되었습니다.");
      } catch(e){
        console.error(e);
        alert(String(e.message || e));
      }
    };
  }

  // 모달 바깥 클릭 닫기
  const modal = el("modal");
  if(modal){
    modal.addEventListener("click", (evt)=>{
      if(evt.target === modal) closeModal();
    });
  }
}

/* ---------- 예약 트랜잭션 (선착순 + 1인1회) ---------- */
async function reserveSlotTransactional(slotId, payload){
  const user = auth.currentUser;
  if(!user) throw new Error("로그인이 필요합니다.");

  const slotRef = db.collection("slots").doc(slotId);
  const resRef  = db.collection("reservations").doc(user.uid);

  await db.runTransaction(async (tx)=>{
    const [slotSnap, resSnap] = await Promise.all([
      tx.get(slotRef),
      tx.get(resRef)
    ]);

    if(!slotSnap.exists) throw new Error("해당 슬롯이 존재하지 않습니다.");
    const slot = slotSnap.data();

    // 교사코드 일치 확인 (링크로 들어온 교사만)
    if(slot.teacherCode !== teacherCode) throw new Error("잘못된 교사 링크입니다.");

    if(slot.status !== "open") throw new Error("이미 예약된 시간입니다.");

    // 1인 1회
    if(resSnap.exists) throw new Error("이미 예약이 있습니다. 취소 후 다시 신청하세요.");

    // 슬롯 업데이트
    tx.update(slotRef, {
      status: "booked",
      bookedByUid: user.uid,
      bookedAt: firebase.firestore.FieldValue.serverTimestamp(),
      bookedType: payload.bookedType,
      bookedName: payload.bookedName,
      bookedPhone: payload.bookedPhone,
      bookedStudentNo: payload.bookedStudentNo
    });

    // 내 예약 기록 생성 (문서ID = uid)
    tx.set(resRef, {
      teacherCode: teacherCode,
      slotId: slotId,
      date: slot.date,
      time: slot.time,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
}

/* ---------- 취소 (자유) ---------- */
async function cancelMyReservation(res){
  const user = auth.currentUser;
  if(!user) return;

  const resRef = db.collection("reservations").doc(user.uid);
  const slotRef = db.collection("slots").doc(res.slotId);

  await db.runTransaction(async (tx)=>{
    const [resSnap, slotSnap] = await Promise.all([tx.get(resRef), tx.get(slotRef)]);
    if(!resSnap.exists) throw new Error("예약 정보가 없습니다.");
    if(!slotSnap.exists) throw new Error("슬롯이 없습니다.");

    const slot = slotSnap.data();

    // 본인 예약만 취소 가능
    if(slot.bookedByUid !== user.uid) throw new Error("본인 예약만 취소할 수 있습니다.");

    // 슬롯 되돌리기
    tx.update(slotRef, {
      status: "open",
      bookedByUid: null,
      bookedAt: null,
      bookedType: null,
      bookedName: null,
      bookedPhone: null,
      bookedStudentNo: null
    });

    // 내 예약 문서 삭제
    tx.delete(resRef);
  });

  alert("예약이 취소되었습니다.");
}

/* ---------- 로그인/로그아웃 ---------- */
async function signIn(){
  const provider = new firebase.auth.GoogleAuthProvider();
  await auth.signInWithPopup(provider);
}

async function signOut(){
  await auth.signOut();
  location.href = "index.html";
}

/* ---------- 페이지 초기화: 교사용 ---------- */
async function initTeacherPage(){
  PAGE = "teacher";

  // UI events
  const btnLogout = el("btnLogout");
  if(btnLogout) btnLogout.onclick = signOut;

  const btnCopy = el("btnCopy");
  if(btnCopy) btnCopy.onclick = ()=>{
    navigator.clipboard.writeText(el("linkBox").value);
    alert("링크가 복사되었습니다.");
  };

  const btnExcel = el("btnExcel");
  if(btnExcel) btnExcel.onclick = downloadExcelTeacher;

  const prev = el("prevMonth");
  const next = el("nextMonth");
  if(prev) prev.onclick = ()=> changeMonth(-1);
  if(next) next.onclick = ()=> changeMonth(+1);

  const btnOpenSlots = el("btnOpenSlots");
  if(btnOpenSlots) btnOpenSlots.onclick = openSelectedSlots;

  // auth
  await signIn();
  const user = auth.currentUser;

  setText("meBadge", user.displayName ? `${user.displayName} (교사)` : "교사");

  teacherCode = await getOrCreateTeacherCode(user);

  const link = `${location.origin}${location.pathname.replace(/teacher\.html$/,"apply.html")}?teacher=${teacherCode}`;
  el("linkBox").value = link;

  // QR
  const qr = new QRious({
    element: el("qrCanvas"),
    value: link,
    size: 160
  });

  // month init
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth();
  selectedDateStr = null;

  subscribeMonth();
  renderMonth();
}

/* ---------- 페이지 초기화: 학생/학부모 ---------- */
async function initApplyPage(){
  PAGE = "apply";

  const btnLogout = el("btnLogout");
  if(btnLogout) btnLogout.onclick = signOut;

  const prev = el("prevMonth");
  const next = el("nextMonth");
  if(prev) prev.onclick = ()=> changeMonth(-1);
  if(next) next.onclick = ()=> changeMonth(+1);

  // teacher param required
  const params = new URLSearchParams(location.search);
  teacherCode = params.get("teacher") || null;
  setText("teacherBadge", `teacher=${teacherCode || "-"}`);

  if(!teacherCode){
    alert("교사 링크가 필요합니다. 교사에게 받은 링크로 접속하세요.");
    // 테스트 접근은 허용하되 기능 제한
  }

  await signIn();
  bindModalUI();
  subscribeMyReservation();

  // month init
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth();
  selectedDateStr = null;

  if(teacherCode){
    subscribeMonth();
    renderMonth();
  } else {
    // teacherCode 없으면 달력 비활성
    setText("monthTitle", `${viewYear}년 ${viewMonth+1}월`);
    setHTML("calendar", `<div class="muted">교사 링크가 없으면 예약 달력을 표시할 수 없습니다.</div>`);
  }
}

/* ---------- 월 이동 ---------- */
function changeMonth(delta){
  const d = new Date(viewYear, viewMonth, 1);
  d.setMonth(d.getMonth()+delta);
  viewYear = d.getFullYear();
  viewMonth = d.getMonth();
  selectedDateStr = null;

  subscribeMonth();
  renderMonth();

  // 하단 초기화
  setText("selectedDateTitle", "날짜를 선택하세요");
  const slots = el("slots");
  if(slots) slots.innerHTML = "";
  if(PAGE==="teacher"){
    const tb = el("bookingTbody");
    if(tb) tb.innerHTML = `<tr><td colspan="6" class="muted center">날짜를 선택하면 예약 현황이 표시됩니다.</td></tr>`;
  }
}
