
function downloadExcel() {
  const data = [
    {날짜:'2026-03-20', 시간:'10:00', 신청자구분:'학생', 이름:'김OO', 전화번호:'010-****'},
    {날짜:'2026-03-21', 시간:'11:00', 신청자구분:'학부모', 이름:'이OO', 전화번호:'010-****'}
  ];

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "상담현황");
  XLSX.writeFile(wb, "상담현황.xlsx");
}

function copyLink(){
  navigator.clipboard.writeText(document.getElementById("linkBox").value);
  alert("링크가 복사되었습니다.");
}

function initTeacherPage(){
  document.getElementById("linkBox").value =
    location.origin + "/apply.html?teacher=TCH-XXXX";
}
