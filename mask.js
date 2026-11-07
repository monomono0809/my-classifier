/* 개인정보 가리기: 이름 · 전화번호 · 사번.
   브라우저 안에서만 동작하고, 가린 문장만 분류에 쓴다. */
(function (root) {
  "use strict";

  var SURNAMES = "김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진지엄채원천방공현변염여추도소석선설마길연위표명기반왕금옥인맹제탁국어은편용예경봉사부";

  // 전화번호: 010-0000-0001, 02-555-0142, 01000000001 같은 모양
  var PHONE = /0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g;

  // 사번: '사번' · '사원번호' 뒤의 영문+숫자 코드, 또는 영문 대문자+숫자 5자리 이상
  var EMP_LABELED = /(사번|사원번호)(\s*[:：]?\s*)([A-Za-z]{0,4}-?\d{3,10})/g;
  var EMP_CODE = /\b[A-Z]{1,4}-?\d{5,10}\b/g;

  // 이름: '가상담당자 OOO' 또는 '성 + 이름 두 글자 + 님·씨·직함'
  var FAKE_NAME = /(가상담당자\s*)([가-힣]{1,3})/g;
  var FULL_NAME = new RegExp(
    "([" + SURNAMES + "])([가-힣]{2})(\\s*)(님|씨|대표|대리|과장|팀장|부장|사원)",
    "g"
  );

  function mask(text) {
    var s = String(text == null ? "" : text);
    // 사번을 먼저: 숫자가 전화번호로 오인되지 않게 한다.
    s = s.replace(EMP_LABELED, function (_, label, sep) {
      return label + sep + "[사번]";
    });
    s = s.replace(EMP_CODE, "[사번]");
    s = s.replace(PHONE, "[전화번호]");
    s = s.replace(FAKE_NAME, function (_, prefix) {
      return prefix + "[이름]";
    });
    s = s.replace(FULL_NAME, function (_, a, b, sp, title) {
      return "[이름]" + sp + title;
    });
    return s;
  }

  var SCOPE =
    "가리는 범위: 전화번호, '사번·사원번호' 뒤의 번호나 영문+숫자 코드, " +
    "'가상담당자' 뒤의 이름, 성+이름 뒤에 님·씨·직함이 붙은 이름. " +
    "그 밖의 이름은 가리지 못할 수 있으니 입력하기 전에 직접 확인해 주세요.";

  var api = { mask: mask, SCOPE: SCOPE };
  root.Mask = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
