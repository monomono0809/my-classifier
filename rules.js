/* 규칙 분류기. 칸 순서와 긴급도 이름은 criteria.json,
   낱말은 keywords.json에서 받아 쓴다. 코드에는 낱말도 정답도 없다. */
(function (root) {
  "use strict";

  function norm(s) {
    return String(s).replace(/\s+/g, " ").trim();
  }

  function hits(text, list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (text.indexOf(list[i]) !== -1) out.push(list[i]);
    }
    return out;
  }

  function quote(list) {
    return list
      .slice(0, 2)
      .map(function (k) { return "‘" + k + "’"; })
      .join("·");
  }

  // 받침이 있으면 '으로', 없거나 ㄹ이면 '로'
  function ro(word) {
    var c = word.charCodeAt(word.length - 1) - 0xac00;
    if (c < 0 || c > 11171) return "로";
    var t = c % 28;
    return t === 0 || t === 8 ? "로" : "으로";
  }

  /* maskedText: 이미 가려진 문장. 반환: { category, urgency, reason } */
  function classify(maskedText, criteria, keywords) {
    var text = norm(maskedText);

    // 칸: criteria.json의 순서에서 가장 앞에 해당하는 칸
    var order = criteria.categories
      .slice()
      .sort(function (a, b) { return a.order - b.order; })
      .map(function (c) { return c.name; });
    var fallback = order[order.length - 1];
    var matched = [];
    order.forEach(function (name) {
      var def = keywords.categories[name];
      var found = def && def.keywords ? hits(text, def.keywords) : [];
      if (found.length) matched.push({ name: name, found: found });
    });
    var category = matched.length ? matched[0].name : fallback;

    // 긴급도: criteria.json 순서 = 높음, 보통, 낮음
    var uNames = criteria.urgency.map(function (u) { return u.name; });
    var high = uNames[0], mid = uNames[1], low = uNames[2];
    function uk(name) {
      return keywords.urgency[name] ? keywords.urgency[name].keywords : [];
    }
    var urgency, uFound;
    if ((uFound = hits(text, uk(high))).length) urgency = high;
    else if ((uFound = hits(text, uk(low))).length) urgency = low;
    else if ((uFound = hits(text, uk(mid))).length) urgency = mid;
    else { urgency = low; uFound = []; }

    // 이유 한 줄
    var why1;
    if (matched.length) {
      why1 = quote(matched[0].found) + " 낱말이 있어 " + category + ro(category) + " 봤어요";
      if (matched.length > 1) why1 += "(" + matched[1].name + " 낱말도 있지만 앞 칸 우선)";
    } else {
      why1 = "다섯 칸 낱말이 없어 " + category + ro(category) + " 봤어요";
    }
    var why2 = uFound.length
      ? quote(uFound) + " 표현이 있어 긴급도 " + urgency
      : "긴급 표현이 없어 긴급도 " + urgency;
    return { category: category, urgency: urgency, reason: why1 + ". " + why2 + "." };
  }

  var api = { classify: classify };
  root.Rules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
