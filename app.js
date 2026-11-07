/* 화면 연결. 기준(criteria.json)·낱말(keywords.json)·연습 문장(practice.json)은
   시작할 때 읽고, 정답(answer.json)은 «규칙으로 채점»을 누를 때만 읽는다. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var state = { criteria: null, keywords: null, practice: null };

    var URG_MARK = { 0: "▲ ", 1: "◆ ", 2: "● " };

  /* ---------- 파일 읽기 ---------- */
  function loadJson(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(path + " (" + r.status + ")");
      return r.json();
    });
  }

  function showFileError(failed) {
    var box = $("load-error");
    box.textContent = "";
    var p = document.createElement("div");
    p.textContent = "다음 파일을 불러오지 못했어요: " + failed.join(", ");
    var ul = document.createElement("ul");
    [
      "파일이 index.html과 같은 폴더(data 파일은 data 폴더)에 있는지 확인해 주세요.",
      "index.html을 더블클릭해 열었다면 브라우저가 파일 읽기를 막을 수 있어요. 폴더에서 'python -m http.server 8000'을 실행한 뒤 http://localhost:8000 으로 열어 주세요.",
      "파일 내용이 올바른 JSON인지 확인해 주세요."
    ].forEach(function (t) {
      var li = document.createElement("li");
      li.textContent = t;
      ul.appendChild(li);
    });
    box.appendChild(p);
    box.appendChild(ul);
    box.hidden = false;
  }

  /* ---------- 공통: 가리고 분류 (분류·채점 모두 이 함수만 쓴다) ---------- */
  function classifyText(raw) {
    var masked = Mask.mask(raw);
    var r = Rules.classify(masked, state.criteria, state.keywords);
    return { masked: masked, category: r.category, urgency: r.urgency, reason: r.reason };
  }

  function urgIndex(name) {
    return state.criteria.urgency.map(function (u) { return u.name; }).indexOf(name);
  }

  function setUrg(el, name) {
    var i = urgIndex(name);
    el.className = "pill";
    el.setAttribute("data-level", i);
    el.textContent = (URG_MARK[i] || "") + name;
  }

  /* ---------- AI 호출 (서버 함수 api/classify 만 부른다. 열쇠는 서버에만 있다) ---------- */
  var AI_TIMEOUT_MS = 70000;

  // items: [{id, text}] — text 는 반드시 가린 문장. 성공하면 서버 응답을 돌려준다.
  function aiCall(items) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, AI_TIMEOUT_MS);
    return fetch("api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items }),
      cache: "no-store",
      signal: ctrl.signal
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = JSON.parse(t); } catch (e) { d = null; }
        if (!r.ok || !d || !d.ok) {
          throw new Error((d && d.error) || ("AI 서버가 응답하지 않았어요 (" + r.status + ")"));
        }
        return d;
      });
    }).catch(function (e) {
      if (e && e.name === "AbortError") throw new Error("AI 응답이 70초 안에 오지 않았어요.");
      if (e instanceof TypeError) throw new Error("AI 서버에 연결하지 못했어요.");
      throw e;
    }).then(
      function (d) { clearTimeout(timer); return d; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  function validAi(r) {
    return r && state.criteria.categories.some(function (c) { return c.name === r.category; }) &&
      state.criteria.urgency.some(function (u) { return u.name === r.urgency; });
  }

  /* ---------- 탭 ---------- */
  function initTabs() {
    var tabs = [$("tab-classify"), $("tab-grade")];
    function select(t) {
      tabs.forEach(function (x) {
        var on = x === t;
        x.setAttribute("aria-selected", on ? "true" : "false");
        x.tabIndex = on ? 0 : -1;
        $(x.getAttribute("aria-controls")).hidden = !on;
      });
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(t); });
      t.addEventListener("keydown", function (e) {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          var n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
          select(n);
          n.focus();
        }
      });
    });
  }

  /* ---------- ① 분류 ---------- */
  var classifyToken = 0;

  function initClassify() {
    $("mask-scope").textContent = Mask.SCOPE;

    $("form").addEventListener("submit", function (e) {
      e.preventDefault();
      var raw = $("q").value;
      var hint = $("hint");
      if (!raw.trim()) {
        hint.textContent = "문의 한 줄을 입력해 주세요.";
        hint.className = "hint warn";
        $("result").hidden = true;
        $("q").focus();
        return;
      }
      hint.textContent = "";
      hint.className = "hint";
      var r = classifyText(raw);
      var token = ++classifyToken;
      var goBtn = $("go");
      goBtn.disabled = true;
      $("masked").textContent = r.masked;
      $("r-cat").textContent = "–";
      $("r-urg").className = "pill";
      $("r-urg").removeAttribute("data-level");
      $("r-urg").textContent = "–";
      $("r-why").textContent = "";
      $("r-src").className = "src-tag";
      $("r-src").textContent = "AI(Gemini)가 분류하는 중…";

      // 외부 AI로는 가린 문장만 보낸다.
      aiCall([{ id: "q", text: r.masked }]).then(function (d) {
        var a = (d.results || []).filter(function (x) { return x.id === "q"; })[0];
        if (!validAi(a)) throw new Error((d.errors && d.errors.q) || "AI 답이 올바르지 않아요.");
        if (token !== classifyToken) return;
        $("r-cat").textContent = a.category;
        setUrg($("r-urg"), a.urgency);
        $("r-why").textContent = a.reason;
        $("r-src").className = "src-tag";
        $("r-src").textContent = "AI(Gemini)가 분류했어요 · 모델 " + d.model;
      }).catch(function (err) {
        if (token !== classifyToken) return;
        $("r-cat").textContent = r.category;
        setUrg($("r-urg"), r.urgency);
        $("r-why").textContent = r.reason;
        var tag = $("r-src");
        tag.className = "src-tag fallback";
        tag.textContent = "AI 없이 규칙으로 갈랐습니다";
        var small = document.createElement("small");
        small.textContent = "AI를 쓰지 못한 이유: " + err.message;
        tag.appendChild(small);
      }).then(function () {
        if (token === classifyToken) goBtn.disabled = false;
      });

      var box = $("result");
      box.hidden = false;
      // 카드 등장 효과를 매번 다시 보여준다
      box.querySelectorAll(".reveal").forEach(function (c) {
        c.style.animation = "none";
        void c.offsetWidth;
        c.style.animation = "";
      });
    });
  }

  function pickExamples() {
    var list = state.practice.filter(function (p) { return p.text && p.text.length <= 70; });
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = list[i]; list[i] = list[j]; list[j] = t;
    }
    var seen = {}, out = [];
    list.forEach(function (p) {
      if (out.length < 3 && !seen[p.category]) { seen[p.category] = true; out.push(p); }
    });
    return out;
  }

  function renderExamples() {
    var wrap = $("examples");
    wrap.textContent = "";
    pickExamples().forEach(function (p) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "example";
      b.textContent = p.text;
      b.addEventListener("click", function () { fillInput(p.text); });
      wrap.appendChild(b);
    });

    // 🔀 예시 문장 넣기: 누를 때마다 연습 문장 하나를 입력창에 채운다 (분류는 하지 않는다)
    $("btn-sample").addEventListener("click", function () {
      var list = state.practice.filter(function (p) { return p.text && p.text.length <= 70; });
      var cur = $("q").value;
      var pick;
      do { pick = list[Math.floor(Math.random() * list.length)]; } while (list.length > 1 && pick.text === cur);
      fillInput(pick.text);
    });
  }

  function fillInput(text) {
    $("q").value = text;
    $("hint").textContent = "";
    $("hint").className = "hint";
    $("q").focus();
  }

  // 안내 상자의 칸/긴급도 꼬리표는 criteria.json에서 만든다
  function renderIntro() {
    var c = state.criteria;
    function fill(id, names) {
      var ul = $(id);
      ul.textContent = "";
      names.forEach(function (n) {
        var li = document.createElement("li");
        li.textContent = n;
        ul.appendChild(li);
      });
    }
    fill("tags-cat", c.categories.slice().sort(function (a, b) { return a.order - b.order; }).map(function (x) { return x.name; }));
    fill("tags-urg", c.urgency.map(function (u) { return u.name; }));
  }

  function renderBasis() {
    var body = $("basis-body");
    body.textContent = "";
    var byId = {};
    state.practice.forEach(function (p) { byId[p.id] = p; });

    function el(tag, text, cls) {
      var e = document.createElement(tag);
      if (text != null) e.textContent = text;
      if (cls) e.className = cls;
      return e;
    }

    function row(tagText, level, definition, def) {
      var div = el("div", null, "lg-row");
      var head = el("div", null, "lg-head");
      var tag = el("span", tagText, "lg-tag");
      if (level != null) tag.setAttribute("data-level", level);
      head.appendChild(tag);
      head.appendChild(el("span", definition, "lg-desc"));
      div.appendChild(head);
      if (def && def.keywords && def.keywords.length) {
        var kws = el("p");
        def.keywords.forEach(function (k) { kws.appendChild(el("span", k, "kw")); });
        div.appendChild(kws);
      }
      if (def && def.note) div.appendChild(el("p", def.note));
      if (def && def.examples && def.examples.length) {
        var ul = el("ul", null, "src");
        def.examples.forEach(function (ex) {
          var li = document.createElement("li");
          var src = byId[ex.id];
          li.appendChild(el("b", ex.id + " · ‘" + ex.keyword + "’"));
          li.appendChild(document.createTextNode(" — " + (src ? Mask.mask(src.text) : "(연습 문장을 찾지 못했어요)")));
          ul.appendChild(li);
        });
        div.appendChild(ul);
      }
      body.appendChild(div);
    }

    body.appendChild(el("p", "낱말은 모두 data/practice.json의 연습 문장에서만 뽑았어요. 아래 예시는 낱말을 뽑은 문장입니다. (AI는 이 낱말이 아니라 위 정의로 판단하고, AI를 쓰지 못할 때만 이 낱말 규칙을 써요.)"));
    body.appendChild(el("h3", "칸 (앞 칸일수록 우선)"));
    var nums = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
    state.criteria.categories
      .slice().sort(function (a, b) { return a.order - b.order; })
      .forEach(function (c) {
        row((nums[c.order - 1] || c.order + ".") + " " + c.name, null, c.definition, state.keywords.categories[c.name]);
      });
    body.appendChild(el("h3", "긴급도"));
    state.criteria.urgency.forEach(function (u, i) {
      row(u.name, i, u.definition, state.keywords.urgency[u.name]);
    });

    var soft = el("div", null, "lg-note");
    soft.appendChild(el("p", "💬 애매할 때", "lg-note-title"));
    var ul1 = document.createElement("ul");
    state.criteria.priority_rules.concat([state.criteria.urgency_note]).forEach(function (t) {
      ul1.appendChild(el("li", t));
    });
    soft.appendChild(ul1);
    body.appendChild(soft);
    body.appendChild(el("p", state.keywords.urgency_rule));

    var warn = el("div", null, "lg-note lg-warn");
    warn.appendChild(el("p", "🚩 가장 중요한 오류", "lg-note-title"));
    var ul2 = document.createElement("ul");
    ul2.appendChild(el("li", "사업비·정산 문의를 다른 칸으로 잘못 배정하는 것"));
    warn.appendChild(ul2);
    body.appendChild(warn);
  }

  /* ---------- ② 채점 ---------- */
  function pct(n, d) { return d ? (Math.round((n / d) * 1000) / 10).toFixed(1) + "%" : "–"; }

  function initGrade() {
    $("grade-btn").addEventListener("click", function () {
      var btn = $("grade-btn");
      var status = $("grade-status");
      btn.disabled = true;
      status.className = "hint";
      status.textContent = "정답 파일을 불러오는 중…";
      loadJson("data/answer.json").then(function (answers) {
        if (!Array.isArray(answers) || !answers.length) throw new Error("data/answer.json (비어 있거나 목록이 아님)");
        var okCat = 0, okUrg = 0, okBoth = 0, wrong = [];
        answers.forEach(function (a) {
          var r = classifyText(a.text);
          var c = r.category === a.category, u = r.urgency === a.urgency;
          if (c) okCat++;
          if (u) okUrg++;
          if (c && u) okBoth++;
          if (!(c && u)) wrong.push({ a: a, r: r, c: c, u: u });
        });
        var n = answers.length;
        $("s-cat").textContent = pct(okCat, n);
        $("s-cat-n").textContent = okCat + "/" + n;
        $("s-urg").textContent = pct(okUrg, n);
        $("s-urg-n").textContent = okUrg + "/" + n;
        $("s-both").textContent = okBoth + "/" + n;
        $("s-both-n").textContent = pct(okBoth, n);
        renderWrong(wrong);
        renderMeta(n);
        status.textContent = "채점했어요. (" + n + "문장)";
      }).catch(function (err) {
        status.className = "hint warn";
        status.textContent = "채점하지 못했어요. 불러오지 못한 파일: " + err.message +
          " — data 폴더에 answer.json이 있는지, 로컬 서버(python -m http.server 8000)로 열었는지 확인해 주세요.";
      }).then(function () { btn.disabled = false; });
    });
  }

  function renderWrong(wrong) {
    $("wrong-card").hidden = false;
    var ul = $("wrong");
    ul.textContent = "";
    $("wrong-empty").hidden = wrong.length > 0;
    wrong.forEach(function (w) {
      var li = document.createElement("li");
      var top = document.createElement("div");
      var id = document.createElement("span");
      id.className = "w-id";
      id.textContent = w.a.id || "";
      top.appendChild(id);
      top.appendChild(document.createTextNode(w.r.masked));
      li.appendChild(top);
      [["칸", w.a.category, w.r.category, w.c], ["긴급도", w.a.urgency, w.r.urgency, w.u]].forEach(function (x) {
        var line = document.createElement("div");
        line.className = "w-line";
        line.appendChild(document.createTextNode(x[0] + ": " + x[1] + " → " + x[2] + "  "));
        var tag = document.createElement("span");
        tag.className = x[3] ? "ok" : "bad";
        tag.textContent = x[3] ? "맞음" : "틀림";
        line.appendChild(tag);
        li.appendChild(line);
      });
      ul.appendChild(li);
    });
  }

  function renderMeta(n) {
    var meta = $("meta");
    meta.textContent = "";
    function row(k, v) {
      var dt = document.createElement("dt"); dt.textContent = k;
      var dd = document.createElement("dd"); dd.textContent = v;
      meta.appendChild(dt); meta.appendChild(dd);
    }
    var c = state.criteria, k = state.keywords;
    row("평가 데이터", "data/answer.json · " + n + "문장");
    row("분류 기준", "criteria.json 버전 " + c.version);
    row("낱말 목록", "keywords.json · 버전 표기 없음 (낱말 출처: " + k.source + ")");
    row("분류 방식", "규칙 기반 (AI 미사용)");
    row("채점 시각", new Date().toLocaleString("ko-KR"));
    $("meta-card").hidden = false;
  }

  /* ---------- ② 채점: AI ---------- */
  var BATCH = 10;
  var lastAiRun = null;

  function tally(rows) {
    var cat = 0, urg = 0, both = 0;
    rows.forEach(function (x) {
      var c = !!x.out && x.out.category === x.gold.category;
      var u = !!x.out && x.out.urgency === x.gold.urgency;
      if (c) cat++;
      if (u) urg++;
      if (c && u) both++;
    });
    return { cat: cat, urg: urg, both: both };
  }

  function setBar(done, n) {
    $("ai-progress").hidden = false;
    $("ai-bar").style.width = Math.round((done / n) * 100) + "%";
  }

  function initAiGrade() {
    $("ai-btn").addEventListener("click", function () {
      var btn = $("ai-btn"), dl = $("ai-dl"), status = $("ai-status");
      btn.disabled = true;
      dl.disabled = true;
      status.className = "hint";
      status.textContent = "정답 파일을 불러오는 중…";
      var model = null;

      loadJson("data/answer.json").then(function (answers) {
        if (!Array.isArray(answers) || !answers.length) throw new Error("data/answer.json (비어 있거나 목록이 아님)");
        var n = answers.length;
        var rows = answers.map(function (a, i) {
          var r = classifyText(a.text);
          return {
            key: "r" + i,
            id: a.id || String(i + 1),
            masked: r.masked,
            gold: { category: a.category, urgency: a.urgency },
            rule: { category: r.category, urgency: r.urgency, reason: r.reason },
            out: null,
            error: null
          };
        });
        var done = 0;
        status.textContent = "AI 채점 중… 0/" + n;
        setBar(0, n);

        // 10개씩 차례로 보낸다 (30개면 세 번)
        var chain = Promise.resolve();
        for (var s = 0; s < n; s += BATCH) {
          (function (batch) {
            chain = chain.then(function () {
              return aiCall(batch.map(function (x) { return { id: x.key, text: x.masked }; })).then(function (d) {
                if (d.model) model = d.model;
                var byKey = {};
                (d.results || []).forEach(function (r) { byKey[r.id] = r; });
                batch.forEach(function (x) {
                  if (validAi(byKey[x.key])) {
                    x.out = { category: byKey[x.key].category, urgency: byKey[x.key].urgency, reason: byKey[x.key].reason };
                  } else {
                    x.error = (d.errors && d.errors[x.key]) || "AI 답이 올바르지 않아요.";
                  }
                });
              }, function (err) {
                batch.forEach(function (x) { x.error = err.message; });
              }).then(function () {
                done += batch.length;
                status.textContent = "AI 채점 중… " + done + "/" + n;
                setBar(done, n);
              });
            });
          })(rows.slice(s, s + BATCH));
        }
        return chain.then(function () { return rows; });
      }).then(function (rows) {
        var n = rows.length;
        var ruleRows = rows.map(function (x) { return { gold: x.gold, out: x.rule }; });
        var aiRows = rows.map(function (x) { return { gold: x.gold, out: x.out }; });
        var rs = tally(ruleRows), as = tally(aiRows);
        var missing = rows.filter(function (x) { return !x.out; });

        var body = $("cmp-body");
        body.textContent = "";
        [
          ["칸 정확도", pct(rs.cat, n) + " (" + rs.cat + "/" + n + ")", pct(as.cat, n) + " (" + as.cat + "/" + n + ")"],
          ["긴급도 정확도", pct(rs.urg, n) + " (" + rs.urg + "/" + n + ")", pct(as.urg, n) + " (" + as.urg + "/" + n + ")"],
          ["둘 다 맞은 수", rs.both + "/" + n, as.both + "/" + n],
          ["답을 못 받은 문장 (오답으로 셈)", "해당 없음", missing.length + "건"]
        ].forEach(function (r) {
          var tr = document.createElement("tr");
          var th = document.createElement("th"); th.scope = "row"; th.textContent = r[0];
          var a = document.createElement("td"); a.textContent = r[1];
          var b = document.createElement("td"); b.textContent = r[2];
          tr.appendChild(th); tr.appendChild(a); tr.appendChild(b);
          body.appendChild(tr);
        });

        var fail = $("ai-fail");
        if (missing.length) {
          var reasons = [];
          missing.forEach(function (x) { if (reasons.indexOf(x.error) === -1) reasons.push(x.error); });
          fail.textContent = "답을 못 받은 이유: " + reasons.slice(0, 3).join(" / ");
          fail.hidden = false;
        } else {
          fail.hidden = true;
        }

        var runAt = new Date();
        var meta = $("ai-meta");
        meta.textContent = "";
        [
          ["평가 데이터", "data/answer.json · " + n + "문장 (" + BATCH + "개씩 " + Math.ceil(n / BATCH) + "번 전송)"],
          ["AI 모델", model || "응답을 받지 못해 알 수 없음"],
          ["분류 기준", "criteria.json 버전 " + state.criteria.version],
          ["낱말 목록", "keywords.json · 버전 표기 없음"],
          ["채점 시각", runAt.toLocaleString("ko-KR")]
        ].forEach(function (r) {
          var dt = document.createElement("dt"); dt.textContent = r[0];
          var dd = document.createElement("dd"); dd.textContent = r[1];
          meta.appendChild(dt); meta.appendChild(dd);
        });
        $("ai-card").hidden = false;

        lastAiRun = {
          run_at: runAt.toISOString(),
          data: "data/answer.json",
          count: n,
          batch_size: BATCH,
          model: model,
          criteria_version: state.criteria.version,
          keywords_version: null,
          summary: {
            rule: { category_correct: rs.cat, urgency_correct: rs.urg, both_correct: rs.both, total: n },
            ai: { category_correct: as.cat, urgency_correct: as.urg, both_correct: as.both, total: n, unanswered: missing.length }
          },
          items: rows.map(function (x) {
            return { id: x.id, text_masked: x.masked, gold: x.gold, rule: x.rule, ai: x.out, ai_error: x.error };
          })
        };
        dl.disabled = false;
        status.textContent = "AI 채점을 마쳤어요. (" + n + "문장" + (missing.length ? ", 답을 못 받은 문장 " + missing.length + "건" : "") + ")";
      }).catch(function (err) {
        status.className = "hint warn";
        status.textContent = "AI 채점을 하지 못했어요. 불러오지 못한 파일: " + err.message +
          " — data 폴더에 answer.json이 있는지, 로컬 서버(python -m http.server 8000)로 열었는지 확인해 주세요.";
      }).then(function () { btn.disabled = false; });
    });

    $("ai-dl").addEventListener("click", function () {
      if (!lastAiRun) return;
      var blob = new Blob([JSON.stringify(lastAiRun, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "ai_채점결과.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }

  /* ---------- 시작 ---------- */
  function start() {
    initTabs();
    var files = {
      criteria: "criteria.json",
      keywords: "keywords.json",
      practice: "data/practice.json"
    };
    var failed = [];
    Promise.all(Object.keys(files).map(function (key) {
      return loadJson(files[key]).then(
        function (d) { state[key] = d; },
        function () { failed.push(files[key]); }
      );
    })).then(function () {
      if (failed.length) {
        showFileError(failed);
        $("go").disabled = true;
        $("grade-btn").disabled = true;
        $("ai-btn").disabled = true;
        return;
      }
      initClassify();
      initGrade();
      initAiGrade();
      renderIntro();
      renderExamples();
      renderBasis();
    });
  }

  start();
})();
