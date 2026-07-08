/* Builder Doctor analyzer — pure, runs in Node and browser.
   Input model: { files } where files is { filename: parsedValue }
     - *.json (GUID-named)  -> parsed object
     - Book.json            -> parsed object
     - *.StepPlan.json      -> parsed object
   plus optional logText (Player.log contents as string).
   Output: array of findings, most severe first. */
(function (global) {
  var GUID_JSON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

  function collectContained(spark, out) {
    var kids = spark && spark.ContainedSparks;
    if (Array.isArray(kids)) {
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c && c.GuidInstance) out.push({ guid: c.GuidInstance, name: c.Name || '(unnamed)' });
        collectContained(c, out);
      }
    }
  }

  function buildModel(files) {
    var model = { name: null, book: null, chapters: [], sparks: {}, stepPlans: {} };
    var book = files['Book.json'];
    if (book && typeof book === 'object') { model.book = book; model.name = book.Name || null; }
    for (var fn in files) {
      if (!files.hasOwnProperty(fn)) continue;
      if (/\.StepPlan\.json$/i.test(fn)) {
        model.stepPlans[fn.replace(/\.StepPlan\.json$/i, '')] = files[fn];
        continue;
      }
      if (!GUID_JSON.test(fn)) continue;
      var obj = files[fn];
      if (!obj || typeof obj !== 'object') continue;
      var guid = fn.replace(/\.json$/i, '');
      var t = obj.Type || '';
      if (/Chapters\.Chapter/.test(t) || (Array.isArray(obj.Sparks) && obj.Map)) {
        model.chapters.push({ guid: guid, name: obj.Name || '(unnamed)', sparkGuids: obj.Sparks || [], raw: obj });
      } else if (/Spark/.test(t) || obj.Traits || obj.EffectInstances) {
        model.sparks[guid] = obj;
      }
    }
    if (model.book && Array.isArray(model.book.Chapters)) {
      var order = {};
      model.book.Chapters.forEach(function (g, i) { order[g] = i; });
      model.chapters.sort(function (a, b) {
        var oa = order[a.guid] == null ? 999 : order[a.guid];
        var ob = order[b.guid] == null ? 999 : order[b.guid];
        return oa - ob;
      });
    }
    return model;
  }

  var SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

  function analyze(files, logText) {
    var m = buildModel(files);
    var findings = [];
    var add = function (f) { findings.push(f); };

    // ---- Rule 1: shared top-level instance GUIDs across chapters (linked chapters) ----
    var topMap = {}; // guid -> [chapterName]
    m.chapters.forEach(function (ch) {
      (ch.sparkGuids || []).forEach(function (g) {
        (topMap[g] = topMap[g] || []).push(ch.name);
      });
    });
    var linked = Object.keys(topMap).filter(function (g) {
      var s = {}; topMap[g].forEach(function (n) { s[n] = 1; });
      return Object.keys(s).length > 1;
    });
    if (linked.length) {
      var ex = linked.slice(0, 5).map(function (g) { return g.slice(0, 8) + '… in [' + Array.from(new Set(topMap[g])).join(', ') + ']'; });
      add({
        sev: 'high', jira: 'PLATFORM-2185 / PLATFORM-2247',
        title: 'Linked chapters — the same Spark instance is shared across chapters',
        detail: linked.length + ' Spark instance GUID(s) appear in more than one chapter. This is the "linked chapters" condition left by chapter duplication: edits and wiring in one chapter bleed into the other, and cross-chapter behavior nodes can become undeletable (NRE).',
        evidence: ex,
        workaround: 'Re-run the de-link workaround (tools/finish_duplicated_chapter.py) so each chapter owns unique instance GUIDs. Quit Builder fully before running. Do not hand-edit in Builder while linked.'
      });
    }

    // ---- Rule 2: shared contained-spark GUIDs across chapters ----
    var contMap = {}; // guid -> Set(chapterName)
    m.chapters.forEach(function (ch) {
      (ch.sparkGuids || []).forEach(function (g) {
        var sp = m.sparks[g]; if (!sp) return;
        var kids = []; collectContained(sp, kids);
        kids.forEach(function (k) {
          (contMap[k.guid] = contMap[k.guid] || {})[ch.name] = 1;
        });
      });
    });
    var contDup = Object.keys(contMap).filter(function (g) { return Object.keys(contMap[g]).length > 1; });
    if (contDup.length) {
      add({
        sev: 'medium', jira: 'PLATFORM-2225',
        title: 'Contained (nested) Sparks share GUIDs across chapters',
        detail: contDup.length + ' nested Spark GUID(s) (inside containers such as Screen-Space UI / Crosshair) are duplicated across chapters. Chapter duplication does not re-GUID contained Sparks, leaving a latent duplicate-GUID condition.',
        evidence: contDup.slice(0, 5).map(function (g) { return g.slice(0, 8) + '… in [' + Object.keys(contMap[g]).join(', ') + ']'; }),
        workaround: 'Usually harmless when chapters are played one at a time. If you see cross-chapter UI corruption, rebuild the affected chapter rather than duplicating.'
      });
    }

    // ---- Rule 3: shared StepIds across chapter StepPlans (linked step plans) ----
    var stepMap = {}; // stepId -> [chapterGuid]
    Object.keys(m.stepPlans).forEach(function (cg) {
      var plan = m.stepPlans[cg];
      var steps = (plan && plan.Steps) || [];
      steps.forEach(function (s) { if (s && s.StepId) (stepMap[s.StepId] = stepMap[s.StepId] || []).push(cg); });
    });
    var linkedSteps = Object.keys(stepMap).filter(function (s) { return new Set(stepMap[s]).size > 1; });
    if (linkedSteps.length) {
      var nameOf = function (g) { var c = m.chapters.find(function (x) { return x.guid === g; }); return c ? c.name : g.slice(0, 8); };
      add({
        sev: 'high', jira: 'PLATFORM-2247',
        title: 'Linked Step Manager plans — StepIds shared between chapters',
        detail: linkedSteps.length + ' Step(s) share IDs across chapters, the signature of a duplicated chapter whose Step Manager plan was cloned instead of copied. Editing steps in one chapter alters the other.',
        evidence: linkedSteps.slice(0, 5).map(function (s) { return s.slice(0, 8) + '… in [' + Array.from(new Set(stepMap[s])).map(nameOf).join(', ') + ']'; }),
        workaround: 'Re-run tools/finish_duplicated_chapter.py against the source book to rebuild the duplicate\'s step sidecar with fresh StepIds.'
      });
    }

    // ---- Rule 4: duplicate chapter names ----
    var nameCount = {};
    m.chapters.forEach(function (ch) { (nameCount[ch.name] = nameCount[ch.name] || []).push(ch.guid); });
    var dupNames = Object.keys(nameCount).filter(function (n) { return nameCount[n].length > 1; });
    if (dupNames.length) {
      add({
        sev: 'low', jira: 'PLATFORM-2253',
        title: 'Two or more chapters share the same name',
        detail: 'Duplicated chapters were not renamed. Beyond confusion, identical names make the de-link workaround ambiguous (it matches chapters by name).',
        evidence: dupNames.map(function (n) { return '"' + n + '" ×' + nameCount[n].length; }),
        workaround: 'Rename each duplicate to a unique name before running any GUID-based tooling.'
      });
    }

    // ---- Rule 5: "Animate Play" effect (silent no-op) ----
    var animatePlay = [];
    Object.keys(m.sparks).forEach(function (g) {
      var eff = m.sparks[g].EffectInstances || [];
      eff.forEach(function (e) { if (e && /^Animate Play$/i.test(e.Name || '')) animatePlay.push(g); });
    });
    if (animatePlay.length) {
      add({
        sev: 'medium', jira: 'reference: Animate Play',
        title: '"Animate Play" effect in use — it silently does nothing',
        detail: 'The "Animate Play" effect only scrolls glTF material UVs and is a no-op for object motion. It is easily confused with "Animation Play" (which plays real clips).',
        evidence: [animatePlay.length + ' spark(s) use an "Animate Play" effect'],
        workaround: 'Use Move / Rotate for object motion, or "Animation Play" for baked clips.'
      });
    }

    // ---- Rule 6: Named State Machine present (index-based state refs) ----
    var namedSM = Object.keys(m.sparks).filter(function (g) { return /StateMachineNamed/.test(m.sparks[g].Type || ''); });
    if (namedSM.length) {
      add({
        sev: 'info', jira: 'PLATFORM-2218',
        title: 'Named State Machine(s) present — state references are positional',
        detail: namedSM.length + ' Named State Machine(s) found. State references resolve by index, not by name: reordering or deleting a state silently re-points wiring, and only the last state can be safely removed.',
        evidence: null,
        workaround: 'Add states only at the end; avoid reordering. If you must reorder, re-check every "Go to Named State" / "If State is Named" reference afterward.'
      });
    }

    // ---- Rule 7: multi-chapter informational ----
    if (m.chapters.length > 1) {
      add({
        sev: 'info', jira: 'PLATFORM-2185',
        title: m.chapters.length + ' chapters in this book',
        detail: 'Multi-chapter books are where the behavior-membership and duplication bugs surface. This is informational; the checks above look for the specific signatures.',
        evidence: m.chapters.map(function (c) { return c.name; }),
        workaround: null
      });
    }

    // ---- Log-based rules (optional) ----
    if (logText) {
      var logRules = [
        { re: /GetOrCreateBehaviorUI/, sev: 'high', jira: 'PLATFORM-2185', title: 'Log shows GetOrCreateBehaviorUI errors (cross-chapter behavior mis-scoping)', wa: 'Quit and relaunch Builder to clear the in-memory desync; then avoid cross-chapter editing in one session. The saved book is usually fine.' },
        { re: /SetActiveHudTexture/, sev: 'medium', jira: 'PLATFORM-2215', title: 'Log shows SetActiveHudTexture NRE (Map Explorer play/stop after layout reset)', wa: 'Known missing-unsubscribe bug; harmless to the book. Avoid resetting the layout mid-session.' },
        { re: /HUDWidget|Input ?System|InvalidOperationException/i, sev: 'high', jira: 'PLATFORM-2189', title: 'Log suggests HUDWidget / Input System crash on button click', wa: 'Legacy Input API incompatibility; tracked. Avoid HUD button interactions until patched.' },
        { re: /mismatched Sort Order/i, sev: 'low', jira: 'PLATFORM-2195', title: 'Log shows spurious "mismatched Sort Order Trait" warning', wa: 'Cosmetic initialization warning; safe to ignore.' }
      ];
      logRules.forEach(function (r) {
        if (r.re.test(logText)) add({ sev: r.sev, jira: r.jira, title: r.title, detail: 'Matched a known error signature in the pasted Player.log.', evidence: null, workaround: r.wa });
      });
    }

    findings.sort(function (a, b) { return SEV_RANK[a.sev] - SEV_RANK[b.sev]; });
    return { model: { name: m.name, chapters: m.chapters.map(function (c) { return { name: c.name, sparks: (c.sparkGuids || []).length }; }), stepPlans: Object.keys(m.stepPlans).length, sparkCount: Object.keys(m.sparks).length }, findings: findings };
  }

  var api = { analyze: analyze, buildModel: buildModel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.BuilderDoctor = api;
})(typeof window !== 'undefined' ? window : globalThis);
