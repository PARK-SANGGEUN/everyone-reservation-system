// 🔥 Firebase 설정 (반드시 본인 값으로 교체)
const firebaseConfig = {
  apiKey: "여기에_API_KEY",
  authDomain: "여기에_authDomain",
  projectId: "여기에_projectId",
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

let teacherCode = null;

/* ---------------- 교사용 ---------------- */
function initTeacherPage() {
  auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
    .then(result => {
      const uid = result.user.uid;
      teacherCode = "TCH-" + uid.substring(0, 4).toUpperCase();

      const link = location.origin + "/apply.html?teacher=" + teacherCode;
      document.getElementById("linkBox").value = link;

      renderDummyCalendar();
    });
}

/* ---------------- 학생/학부모 ---------------- */
function initApplyPage() {
  const params = new URLSearchParams(location.search);
  teacherCode = params.get("teacher");

  auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
    .then(() => {
      renderDummyCalendar();
    });
}

/* ---------------- 달력 (임시 더미) ---------------- */
function renderDummyCalendar() {
  const cal = document.getElementById("calendar");
  cal.innerHTML = "";

  for (let i = 1; i <= 30; i++) {
    const d = document.createElement("div");
    d.className = "day";
    d.innerHTML = `<strong>${i}</strong>`;
    d.onclick = () => loadSlots(`2026-03-${String(i).padStart(2,"0")}`);
    cal.appendChild(d);
  }
}

/* ---------------- 시간 슬롯 ---------------- */
function loadSlots(date) {
  document.getElementById("selectedDate").innerText = "📅 " + date;
  const slots = document.getElementById("slots");
  slots.innerHTML = "";

  ["09:00","10:00","11:00","14:00","15:00"].forEach(t => {
    const s = document.createElement("div");
    s.className = "slot";
    s.innerText = t;
    slots.appendChild(s);
  });
}

/* ---------------- 엑셀 다운로드 ---------------- */
function downloadExcel() {
  const data = [
    {날짜:"2026-03-20", 시간:"10:00", 구분:"학생", 이름:"김OO", 전화번호:"010-****"},
    {날짜:"2026-03-21", 시간:"11:00", 구분:"학부모", 이름:"이OO", 전화번호:"010-****"}
  ];

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "상담현황");
  XLSX.writeFile(wb, "상담현황.xlsx");
}

/* ---------------- 링크 복사 ---------------- */
function copyLink() {
  navigator.clipboard.writeText(document.getElementById("linkBox").value);
  alert("링크가 복사되었습니다.");
}
