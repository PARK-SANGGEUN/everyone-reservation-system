/*********************************************************
 * 0) Firebase 설정 (본인 프로젝트 값으로 유지/교체 필수)
 *********************************************************/
const firebaseConfig = {
  apiKey: "AIzaSyXXXXXXXXXXXXXXX",
  authDomain: "adiga-2023-2025.firebaseapp.com",
  projectId: "adiga-2023-2025",
  storageBucket: "adiga-2023-2025.appspot.com",
  messagingSenderId: "XXXXXXXXXX",
  appId: "1:XXXXXXXX:web:XXXXXXXX"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

/*********************************************************
 * 1) 유틸
 *********************************************************/
const $ = (sel) => document.querySelector(sel);

function pad2(n){ return String(n).padStart(2,"0"); }
function toYMD(date){
  const y = date.getFullYear();
  const m = pad2(date.getMonth()+1);
  const d = pad2(date.getDate());
  return `${y}-${m}-${d}`;
}
function parseYMD(ymd){
  const [y,m,d] = ymd.split("-").map(Number);
  return new Date(y, m-1, d);
}
function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonthExclusive(d){ return new Date(d.getFullYear(), d.getMonth()+1, 1); }
function addMonths(d, delta){ return new Date(d.getFullYear(), d.getMonth()+delta, 1); }
function hourToLabel(h){ return `${pad2(h)}:00`; }

function csvEscape(v){
  const s = String(v ?? "");
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}
function downloadCSV(filename, rows){
  const bom = "\uFEFF";
  const csv = rows.map(r => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([bom + csv], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/*********************************************************
 * 2) 공통: 로그인/로그아웃
 *********************************************************/
async function loginWithGoogle(){
  const provider = new firebase.auth.GoogleAuthProvider();
  return auth.signInWithPopup(provider);
}
async function logout(){
  await auth.signOut();
  location.reload();
}
function setLoginStatus(text){
  const el = $(".login-status");
  if (el) el.textContent = text;
}

/*********************************************************
 * 3) 데이터 모델
 * teachers/{uid} : { teacherCode, uid, name, email }
 * slots/{slotId} : { teacherCode, startAt(Timestamp), ymd, hour, status(open/booked), bookedBy, role, name, studentOrChild, phone }
 * reservations/{uid} : { teacherCode, slotId, startAt, ymd, hour, role, name, studentOrChild, phone }
 *********************************************************/
function genTeacherCode(){
  return "TCH-" + Math.random().toString(36).substring(2, 6).toUpperCase();
}
function slotIdOf(teacherCode, ymd, hour){
  return `${teacherCode}_${ymd.replaceAll("-","")}_${pad2(hour)}`;
}

async function ensureTeacherProfile(user){
  const ref = db.collection("teachers").doc(user.uid);
  const snap = await ref.get();
  if (snap.exists) return snap.data();

  const teacherCode = genTeacherCode();
  const data = {
    uid: user.uid,
    email: user.email || "",
    name: user.displayName || "교사",
    teacherCode,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  await ref.set(data);
  return data;
}

function getTeacherCodeFromUrl(){
  const u = new URL(location.href);
  return u.searchParams.get("teacher");
}

/*********************************************************
 * 4) 달력 렌더 공통
 *********************************************************/
function renderMonthCalendar(containerEl, monthDate, dayStatusMap, onPickDate){
  // dayStatusMap: ymd -> "green" | "red" | "gray"
  containerEl.innerHTML = "";

  const first = startOfMonth(monthDate);
  const lastEx = endOfMonthExclusive(monthDate);

  // 달력 시작: 해당 월 1일의 요일(일0~토6)만큼 앞을 비움
  const startWeekday = first.getDay();
  const totalDays = Math.round((lastEx - first) / (1000*60*60*24));

  // 앞쪽 빈칸
  for(let i=0;i<startWeekday;i++){
    const cell = document.createElement("div");
    cell.className = "cal-cell disabled";
    containerEl.appendChild(cell);
  }

  // 날짜들
  for(let d=1; d<=totalDays; d++){
    const date = new Date(first.getFullYear(), first.getMonth(), d);
    const ymd = toYMD(date);
    const color = dayStatusMap.get(ymd) || "gray";

    const cell = document.createElement("div");
    cell.className = "cal-cell";
    cell.dataset.ymd = ymd;

    const dateEl = document.createElement("div");
    dateEl.className = "cal-date";
    dateEl.textContent = String(d);

    const badge = document.createElement("div");
    badge.className = `badge ${color}`;

    cell.appendChild(dateEl);
    cell.appendChild(badge);

    cell.addEventListener("click", () => onPickDate(ymd));
    containerEl.appendChild(cell);
  }
}

/*********************************************************
 * 5) 슬롯 조회 (월 단위)
 *********************************************************/
async function fetchSlotsForMonth(teacherCode, monthDate){
  const start = startOfMonth(monthDate);
  const endEx = endOfMonthExclusive(monthDate);

  // Timestamp 범위
  const qs = await db.collection("slots")
    .where("teacherCode", "==", teacherCode)
    .where("startAt", ">=", firebase.firestore.Timestamp.fromDate(start))
    .where("startAt", "<", firebase.firestore.Timestamp.fromDate(endEx))
    .get();

  const slots = [];
  qs.forEach(doc => slots.push({id: doc.id, ...doc.data()}));
  return slots;
}

function makeDayStatusMap(slots){
  // ymd별로 open 여부/total 계산
  const map = new Map(); // ymd -> {total, open}
  for(const s of slots){
    const ymd = s.ymd;
    if(!map.has(ymd)) map.set(ymd, {total:0, open:0});
    const o = map.get(ymd);
    o.total += 1;
    if(s.status === "open") o.open += 1;
  }

  const status = new Map(); // ymd -> "green"|"red"|"gray"
  for(const [ymd, v] of map.entries()){
    if(v.total === 0) status.set(ymd, "gray");
    else if(v.open > 0) status.set(ymd, "green");
    else status.set(ymd, "red");
  }
  return status;
}

/*********************************************************
 * 6) 교사용 페이지 로직
 *********************************************************/
async function initTeacherPage(user){
  const profile = await ensureTeacherProfile(user);
  const teacherCode = profile.teacherCode;

  setLoginStatus(`${profile.name} 로그인됨`);

  // 교사용 링크
  const link = `${location.origin}/everyone-reservation-system/apply.html?teacher=${encodeURIComponent(teacherCode)}`;
  const linkInput = $("#teacherLink");
  if(linkInput) linkInput.value = link;

  // 링크 복사
  const copyBtn = $("#copyLinkBtn");
  if(copyBtn){
    copyBtn.addEventListener("click", () => {
      linkInput.select();
      document.execCommand("copy");
      alert("교사용 링크가 복사되었습니다.");
    });
  }

  // 시간 체크 UI (09~18)
  const hoursGrid = $("#hoursGrid");
  const hours = [];
  for(let h=9; h<=18; h++) hours.push(h);

  const picked = new Set();
  hoursGrid.innerHTML = "";
  for(const h of hours){
    const div = document.createElement("div");
    div.className = "hour-item";
    div.textContent = hourToLabel(h);
    div.addEventListener("click", ()=>{
      if(picked.has(h)){
        picked.delete(h);
        div.classList.remove("active");
      } else {
        picked.add(h);
        div.classList.add("active");
      }
    });
    hoursGrid.appendChild(div);
  }

  // 슬롯 생성
  const createBtn = $("#createSlotsBtn");
  const dateInput = $("#slotDate");
  if(createBtn){
    createBtn.addEventListener("click", async ()=>{
      const ymd = dateInput.value;
      if(!ymd){ alert("날짜를 선택하세요."); return; }
      if(picked.size === 0){ alert("시간을 1개 이상 선택하세요."); return; }

      createBtn.disabled = true;
      createBtn.textContent = "등록 중…";

      try{
        // 여러 슬롯: 트랜잭션 여러 번(간단/안전)
        let created = 0, skipped = 0;
        for(const hour of Array.from(picked).sort((a,b)=>a-b)){
          const slotId = slotIdOf(teacherCode, ymd, hour);
          const slotRef = db.collection("slots").doc(slotId);

          await db.runTransaction(async (tx)=>{
            const snap = await tx.get(slotRef);
            if(snap.exists){
              skipped += 1;
              return;
            }
            const dt = parseYMD(ymd);
            dt.setHours(hour,0,0,0);

            tx.set(slotRef, {
              teacherCode,
              startAt: firebase.firestore.Timestamp.fromDate(dt),
              ymd,
              hour,
              status: "open",
              createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            created += 1;
          });
        }

        alert(`등록 완료! 생성 ${created}개, 중복 ${skipped}개`);
        picked.clear();
        // UI 체크 해제
        Array.from(hoursGrid.querySelectorAll(".hour-item")).forEach(el=>el.classList.remove("active"));

        // 달력/테이블 갱신
        await refreshTeacherMonth(teacherCode);
      } catch(e){
        console.error(e);
        alert("슬롯 등록 중 오류가 발생했습니다. 콘솔을 확인하세요.");
      } finally {
        createBtn.disabled = false;
        createBtn.textContent = "선택 시간 슬롯 등록";
      }
    });
  }

  // 달력/월 이동/날짜 선택
  let curMonth = startOfMonth(new Date());
  let monthSlots = [];
  let selectedYmd = null;

  const monthLabel = $("#monthLabel");
  const calEl = $("#monthCalendar");
  const selectedLabel = $("#selectedDateLabel");
  const tbody = $("#teacherDayTbody");

  async function pickDate(ymd){
    selectedYmd = ymd;
    if(selectedLabel) selectedLabel.textContent = ymd;

    const daySlots = monthSlots
      .filter(s => s.ymd === ymd)
      .sort((a,b)=>a.hour-b.hour);

    if(daySlots.length === 0){
      tbody.innerHTML = `<tr><td colspan="6" class="muted center">선택 날짜에 슬롯이 없습니다.</td></tr>`;
      return;
    }

    tbody.innerHTML = daySlots.map(s => {
      const state = s.status === "open" ? "예약 가능" : "마감";
      const role = s.role || "-";
      const name = s.name || "-";
      const so = s.studentOrChild || "-";
      const phone = s.phone || "-";
      return `
        <tr>
          <td>${hourToLabel(s.hour)}</td>
          <td>${state}</td>
          <td>${role}</td>
          <td>${name}</td>
          <td>${so}</td>
          <td>${phone}</td>
        </tr>
      `;
    }).join("");
  }

  async function refresh(){
    monthSlots = await fetchSlotsForMonth(teacherCode, curMonth);
    const statusMap = makeDayStatusMap(monthSlots);

    if(monthLabel){
      monthLabel.textContent = `${curMonth.getFullYear()}-${pad2(curMonth.getMonth()+1)}`;
    }
    renderMonthCalendar(calEl, curMonth, statusMap, pickDate);

    // 선택 날짜 유지
    if(selectedYmd){
      await pickDate(selectedYmd);
    } else {
      if(selectedLabel) selectedLabel.textContent = "-";
      tbody.innerHTML = `<tr><td colspan="6" class="muted center">날짜를 선택하면 예약 현황이 표시됩니다.</td></tr>`;
    }
  }

  async function refreshTeacherMonth(){
    await refresh();
  }

  // 외부 호출용
  window.refreshTeacherMonth = refreshTeacherMonth;

  // 월 이동
  $("#prevMonthBtn").addEventListener("click", async ()=>{
    curMonth = addMonths(curMonth, -1);
    selectedYmd = null;
    await refresh();
  });
  $("#nextMonthBtn").addEventListener("click", async ()=>{
    curMonth = addMonths(curMonth, 1);
    selectedYmd = null;
    await refresh();
  });

  // 엑셀 다운로드(전체)
  $("#exportAllBtn").addEventListener("click", async ()=>{
    // 현재 월 기준으로 다운로드
    const rows = [
      ["날짜","시간","상태","구분","이름","학번/자녀","연락처"]
    ];
    const all = monthSlots.slice().sort((a,b)=>{
      if(a.ymd===b.ymd) return a.hour-b.hour;
      return a.ymd.localeCompare(b.ymd);
    });
    for(const s of all){
      rows.push([
        s.ymd,
        hourToLabel(s.hour),
        s.status==="open" ? "예약 가능" : "마감",
        s.role || "",
        s.name || "",
        s.studentOrChild || "",
        s.phone || ""
      ]);
    }
    downloadCSV(`상담현황_${teacherCode}_${monthLabel.textContent}.csv`, rows);
  });

  // 엑셀 다운로드(선택 날짜)
  $("#exportDayBtn").addEventListener("click", async ()=>{
    if(!selectedYmd){ alert("날짜를 먼저 선택하세요."); return; }
    const rows = [
      ["날짜","시간","상태","구분","이름","학번/자녀","연락처"]
    ];
    const day = monthSlots.filter(s=>s.ymd===selectedYmd).sort((a,b)=>a.hour-b.hour);
    for(const s of day){
      rows.push([
        s.ymd,
        hourToLabel(s.hour),
        s.status==="open" ? "예약 가능" : "마감",
        s.role || "",
        s.name || "",
        s.studentOrChild || "",
        s.phone || ""
      ]);
    }
    downloadCSV(`상담현황_${teacherCode}_${selectedYmd}.csv`, rows);
  });

  // 실시간 반영: 현재 달 범위만 스냅샷 리스너
  let unsub = null;
  function startRealtime(){
    if(unsub) unsub();
    const start = startOfMonth(curMonth);
    const endEx = endOfMonthExclusive(curMonth);

    unsub = db.collection("slots")
      .where("teacherCode", "==", teacherCode)
      .where("startAt", ">=", firebase.firestore.Timestamp.fromDate(start))
      .where("startAt", "<", firebase.firestore.Timestamp.fromDate(endEx))
      .onSnapshot(async ()=>{
        await refresh();
      }, (e)=>{
        console.error(e);
      });
  }

  await refresh();
  startRealtime();

  // 월 이동 시 realtime 범위도 갱신
  const oldPrev = $("#prevMonthBtn").onclick;
  const oldNext = $("#nextMonthBtn").onclick;
  $("#prevMonthBtn").onclick = async ()=>{
    curMonth = addMonths(curMonth, -1);
    selectedYmd = null;
    await refresh();
    startRealtime();
  };
  $("#nextMonthBtn").onclick = async ()=>{
    curMonth = addMonths(curMonth, 1);
    selectedYmd = null;
    await refresh();
    startRealtime();
  };
}

/*********************************************************
 * 7) 예약 페이지 로직 (학생/학부모)
 *********************************************************/
async function initApplyPage(user){
  const teacherCode = getTeacherCodeFromUrl();
  const teacherLabel = $("#teacherCodeLabel");
  if(teacherLabel) teacherLabel.textContent = teacherCode || "-";

  if(!teacherCode){
    alert("유효한 교사 링크가 아닙니다. (teacher 파라미터 없음)");
    return;
  }

  setLoginStatus(`${user.displayName || "사용자"} 로그인됨`);

  // 내 예약 로드
  const myBox = $("#myReservationBox");
  const myRef = db.collection("reservations").doc(user.uid);

  async function refreshMyReservation(){
    const snap = await myRef.get();
    if(!snap.exists){
      myBox.innerHTML = `<div class="muted center">현재 예약이 없습니다.</div>`;
      return null;
    }
    const r = snap.data();
    myBox.innerHTML = `
      <div><strong>예약일:</strong> ${r.ymd} ${hourToLabel(r.hour)}</div>
      <div><strong>교사코드:</strong> ${r.teacherCode}</div>
      <div><strong>구분:</strong> ${r.role}</div>
      <div><strong>이름:</strong> ${r.name}</div>
      <div><strong>학번/자녀:</strong> ${r.studentOrChild}</div>
      <div><strong>연락처:</strong> ${r.phone}</div>
    `;
    return r;
  }

  // 취소
  $("#cancelMyBtn").addEventListener("click", async ()=>{
    const r = await refreshMyReservation();
    if(!r){ alert("취소할 예약이 없습니다."); return; }

    if(!confirm("예약을 취소하시겠습니까?")) return;

    try{
      await db.runTransaction(async (tx)=>{
        const rSnap = await tx.get(myRef);
        if(!rSnap.exists) return;

        const rr = rSnap.data();
        const slotRef = db.collection("slots").doc(rr.slotId);
        const sSnap = await tx.get(slotRef);
        if(sSnap.exists){
          const ss = sSnap.data();
          // 본인 예약만 취소 가능
          if(ss.bookedBy === user.uid){
            tx.update(slotRef, {
              status: "open",
              bookedBy: firebase.firestore.FieldValue.delete(),
              role: firebase.firestore.FieldValue.delete(),
              name: firebase.firestore.FieldValue.delete(),
              studentOrChild: firebase.firestore.FieldValue.delete(),
              phone: firebase.firestore.FieldValue.delete(),
              bookedAt: firebase.firestore.FieldValue.delete(),
            });
          }
        }
        tx.delete(myRef); // 1인 1회 제한을 풀기 위해 삭제
      });

      $("#msgBox").textContent = "예약이 취소되었습니다. 다시 예약할 수 있습니다.";
      await refreshAll();
    } catch(e){
      console.error(e);
      alert("취소 중 오류가 발생했습니다.");
    }
  });

  // 달력 / 월 이동 / 날짜 선택
  let curMonth = startOfMonth(new Date());
  let monthSlots = [];
  let selectedYmd = null;
  let pickedSlotId = null;

  const monthLabel = $("#monthLabel");
  const calEl = $("#monthCalendar");
  const selectedLabel = $("#selectedDateLabel");
  const slotsList = $("#slotsList");
  const pickedLabel = $("#pickedSlotLabel");
  const msgBox = $("#msgBox");

  // 역할 토글
  const roleSelect = $("#roleSelect");
  const studentBlock = document.querySelector(".role-student");
  const parentBlock = document.querySelector(".role-parent");
  function updateRoleUI(){
    const v = roleSelect.value;
    if(v==="student"){
      studentBlock.style.display = "";
      parentBlock.style.display = "none";
    } else {
      studentBlock.style.display = "none";
      parentBlock.style.display = "";
    }
  }
  roleSelect.addEventListener("change", updateRoleUI);
  updateRoleUI();

  async function pickDate(ymd){
    selectedYmd = ymd;
    if(selectedLabel) selectedLabel.textContent = ymd;

    const daySlots = monthSlots
      .filter(s => s.ymd === ymd)
      .sort((a,b)=>a.hour-b.hour);

    if(daySlots.length===0){
      slotsList.innerHTML = `<div class="muted center">선택 날짜에 슬롯이 없습니다.</div>`;
      pickedSlotId = null;
      pickedLabel.textContent = "-";
      return;
    }

    slotsList.innerHTML = "";
    for(const s of daySlots){
      const chip = document.createElement("div");
      chip.className = "slot-chip " + (s.status==="open" ? "open" : "booked");
      chip.textContent = `${hourToLabel(s.hour)} ${s.status==="open" ? "예약가능" : "마감"}`;

      if(s.status==="open"){
        chip.addEventListener("click", ()=>{
          // active 처리
          Array.from(slotsList.querySelectorAll(".slot-chip")).forEach(x=>x.classList.remove("active"));
          chip.classList.add("active");
          pickedSlotId = s.id;
          pickedLabel.textContent = `${s.ymd} ${hourToLabel(s.hour)}`;
          msgBox.textContent = "";
        });
      }
      slotsList.appendChild(chip);
    }
  }

  async function refreshMonth(){
    monthSlots = await fetchSlotsForMonth(teacherCode, curMonth);
    const statusMap = makeDayStatusMap(monthSlots);

    if(monthLabel){
      monthLabel.textContent = `${curMonth.getFullYear()}-${pad2(curMonth.getMonth()+1)}`;
    }
    renderMonthCalendar(calEl, curMonth, statusMap, pickDate);

    // 날짜 선택 유지
    if(selectedYmd) await pickDate(selectedYmd);
    else {
      if(selectedLabel) selectedLabel.textContent = "-";
      slotsList.innerHTML = `<div class="muted center">날짜를 선택하면 시간 슬롯이 표시됩니다.</div>`;
    }
  }

  async function refreshAll(){
    await refreshMyReservation();
    await refreshMonth();
  }

  // 월 이동
  $("#prevMonthBtn").addEventListener("click", async ()=>{
    curMonth = addMonths(curMonth, -1);
    selectedYmd = null;
    pickedSlotId = null;
    pickedLabel.textContent = "-";
    await refreshAll();
  });
  $("#nextMonthBtn").addEventListener("click", async ()=>{
    curMonth = addMonths(curMonth, 1);
    selectedYmd = null;
    pickedSlotId = null;
    pickedLabel.textContent = "-";
    await refreshAll();
  });

  // 예약 확정 (⭐ 1인 1회 제한 + 선착순 트랜잭션)
  $("#bookBtn").addEventListener("click", async ()=>{
    msgBox.textContent = "";

    if(!pickedSlotId){
      msgBox.textContent = "시간 슬롯을 먼저 선택하세요.";
      return;
    }

    const role = roleSelect.value;
    const name = $("#nameInput").value.trim();
    const phone = $("#phoneInput").value.trim();
    const studentId = $("#studentIdInput").value.trim();
    const childName = $("#childNameInput").value.trim();

    if(!name){ msgBox.textContent="이름을 입력하세요."; return; }
    if(!phone){ msgBox.textContent="전화번호를 입력하세요."; return; }
    if(role==="student" && !studentId){ msgBox.textContent="학번을 입력하세요."; return; }
    if(role==="parent" && !childName){ msgBox.textContent="자녀 이름을 입력하세요."; return; }

    const slotRef = db.collection("slots").doc(pickedSlotId);

    try{
      await db.runTransaction(async (tx)=>{
        // 1) 이미 예약했는지 확인 (1인 1회)
        const mySnap = await tx.get(myRef);
        if(mySnap.exists){
          throw new Error("ALREADY_RESERVED");
        }

        // 2) 슬롯 상태 확인 (선착순)
        const sSnap = await tx.get(slotRef);
        if(!sSnap.exists) throw new Error("SLOT_NOT_FOUND");

        const s = sSnap.data();
        if(s.status !== "open") throw new Error("SLOT_ALREADY_BOOKED");
        if(s.teacherCode !== teacherCode) throw new Error("TEACHER_MISMATCH");

        const studentOrChild = role==="student" ? studentId : childName;
        const roleLabel = role==="student" ? "학생" : "학부모";

        // 3) 슬롯을 booked로 업데이트
        tx.update(slotRef, {
          status: "booked",
          bookedBy: user.uid,
          role: roleLabel,
          name,
          studentOrChild,
          phone,
          bookedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // 4) reservations/{uid} 생성 (1인 1회 고정)
        tx.set(myRef, {
          uid: user.uid,
          teacherCode,
          slotId: pickedSlotId,
          startAt: s.startAt,
          ymd: s.ymd,
          hour: s.hour,
          role: roleLabel,
          name,
          studentOrChild,
          phone,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });

      msgBox.textContent = "예약이 완료되었습니다!";
      pickedSlotId = null;
      pickedLabel.textContent = "-";
      await refreshAll();

    } catch(e){
      console.error(e);
      if(e.message === "ALREADY_RESERVED"){
        msgBox.textContent = "이미 예약이 있습니다. (1인 1회 제한) 먼저 취소 후 다시 예약하세요.";
      } else if(e.message === "SLOT_ALREADY_BOOKED"){
        msgBox.textContent = "방금 다른 사람이 먼저 예약했습니다. 다른 시간을 선택하세요.";
      } else {
        msgBox.textContent = "예약 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.";
      }
    }
  });

  // 실시간 반영: 월 범위 슬롯 스냅샷
  let unsub = null;
  function startRealtime(){
    if(unsub) unsub();
    const start = startOfMonth(curMonth);
    const endEx = endOfMonthExclusive(curMonth);

    unsub = db.collection("slots")
      .where("teacherCode", "==", teacherCode)
      .where("startAt", ">=", firebase.firestore.Timestamp.fromDate(start))
      .where("startAt", "<", firebase.firestore.Timestamp.fromDate(endEx))
      .onSnapshot(async ()=>{
        await refreshMonth();
        await refreshMyReservation();
      }, (e)=>console.error(e));
  }

  await refreshAll();
  startRealtime();

  // 월 이동 시 realtime 범위 갱신
  const oldPrev = $("#prevMonthBtn").onclick;
  const oldNext = $("#nextMonthBtn").onclick;
  $("#prevMonthBtn").onclick = async ()=>{
    curMonth = addMonths(curMonth, -1);
    selectedYmd = null;
    pickedSlotId = null;
    pickedLabel.textContent = "-";
    await refreshAll();
    startRealtime();
  };
  $("#nextMonthBtn").onclick = async ()=>{
    curMonth = addMonths(curMonth, 1);
    selectedYmd = null;
    pickedSlotId = null;
    pickedLabel.textContent = "-";
    await refreshAll();
    startRealtime();
  };
}

/*********************************************************
 * 8) 페이지 엔트리
 *********************************************************/
(function main(){
  // 로그아웃 버튼
  const logoutBtn = $("#logoutBtn");
  if(logoutBtn) logoutBtn.addEventListener("click", logout);

  const page = document.body.dataset.page;

  auth.onAuthStateChanged(async (user)=>{
    if(!user){
      setLoginStatus("로그인 필요");
      try{
        await loginWithGoogle();
      } catch(e){
        console.error(e);
        alert("로그인에 실패했습니다. 팝업 차단 여부를 확인하세요.");
      }
      return;
    }

    // 로그인 성공
    if(page === "teacher"){
      await initTeacherPage(user);
    } else if(page === "apply"){
      await initApplyPage(user);
    }
  });
})();
