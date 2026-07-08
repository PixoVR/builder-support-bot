/* bookmap.js — turns a parsed .pixob into an LLM-legible representation.
   The reusable core of the diagnostic assistant: it produces (1) a book identity
   map for anchoring "which chapter / which save", and (2) a per-chapter wiring
   digest — the exact context that let a reasoner diagnose the billboard and hazard
   cases by hand. Pure; runs in Node and browser. Depends on analyzer.buildModel. */
(function (global) {
  var BD = (typeof require !== 'undefined') ? require('./analyzer.js') : global.BuilderDoctor;

  function traitVal(json) { try { return JSON.parse(json).Value; } catch (e) { return undefined; } }
  function iname(spark) {
    for (var i = 0; i < (spark.Traits || []).length; i++) {
      var t = spark.Traits[i];
      if (t.Label === 'Instance Name') { var v = traitVal(t.Json); if (v != null) return v; }
    }
    return spark.Name || '(unnamed)';
  }
  function shortType(t) { return (t || '').split('.').pop(); }

  // Compact a param blob to something readable (pull labels / values out of the nested Json).
  function summarizeParams(params) {
    if (!params) return null;
    var out = {};
    for (var k in params) {
      if (!params.hasOwnProperty(k)) continue;
      var v = traitVal(params[k]);
      if (v && typeof v === 'object' && v.Label != null) out[k || 'value'] = v.Label; // DynamicEnum
      else out[k || 'value'] = v;
    }
    return out;
  }

  // Notable traits worth surfacing to a reasoner (visibility, state, datum values, randomizer config).
  var NOTABLE = /Visible|State|Value|Total Values|Valid Values|Require Unique|Loop|Channel|Interactable|Collidable/i;

  // ---- Book identity map (anchoring) ----
  function bookMap(files, meta) {
    var m = BD.buildModel(files);
    return {
      name: m.name,
      note: (meta && meta.savedNote) || 'Reflects the last saved state of the file, not any unsaved edits in Builder.',
      chapterCount: m.chapters.length,
      chapters: m.chapters.map(function (ch) {
        var types = {};
        (ch.sparkGuids || []).forEach(function (g) {
          var sp = m.sparks[g]; if (sp) { var t = shortType(sp.Type); types[t] = (types[t] || 0) + 1; }
        });
        return {
          guid: ch.guid,
          name: ch.name,
          sparkCount: (ch.sparkGuids || []).length,
          hasStepPlan: !!m.stepPlans[ch.guid],
          fingerprint: types            // e.g. { Randomizer:1, StateMachineNamed:5, ... }
        };
      })
    };
  }

  // ---- Per-chapter wiring digest (the reasoning context) ----
  function chapterWiring(files, chapterGuid) {
    var m = BD.buildModel(files);
    var ch = m.chapters.find(function (c) { return c.guid === chapterGuid; });
    if (!ch) return null;

    // label every behavior node in the chapter for edge resolution
    var label = {};
    (ch.sparkGuids || []).forEach(function (g) {
      var sp = m.sparks[g]; if (!sp) return;
      var nm = iname(sp);
      (sp.CauseInstances || []).forEach(function (c) { label[c.GuidInstance] = nm + ' · [cause] ' + c.Name; });
      (sp.EffectInstances || []).forEach(function (e) { label[e.GuidInstance] = nm + ' · ' + e.Name; });
    });
    var resolve = function (g) { return label[g] || (g ? g.slice(0, 8) + '…(external)' : '?'); };
    var outs = function (node) {
      var r = [];
      (node.Effects || []).forEach(function (slot, i) {
        if (Array.isArray(slot)) slot.forEach(function (dst) { r.push({ slot: i, to: resolve(dst) }); });
      });
      return r;
    };

    var sparks = [];
    (ch.sparkGuids || []).forEach(function (g) {
      var sp = m.sparks[g]; if (!sp) return;
      var notable = {};
      (sp.Traits || []).forEach(function (t) {
        if (t.Label && NOTABLE.test(t.Label) && t.Label !== 'Instance Name') {
          var v = traitVal(t.Json);
          notable[t.Label] = (v && typeof v === 'object' && v.Label != null) ? v.Label : v;
        }
      });
      var causes = (sp.CauseInstances || []).map(function (c) { return { name: c.Name, wiredTo: outs(c) }; });
      var effects = (sp.EffectInstances || []).map(function (e) {
        return { name: e.Name, params: summarizeParams(e.Params), wiredTo: outs(e) };
      });
      if (causes.length || effects.length || Object.keys(notable).length) {
        sparks.push({ name: iname(sp), type: shortType(sp.Type), traits: notable, causes: causes, effects: effects });
      }
    });

    return { chapter: { guid: ch.guid, name: ch.name, sparkCount: (ch.sparkGuids || []).length }, sparks: sparks };
  }

  // ---- Resolve a natural-language reference to sparks by instance name ----
  function findSparks(files, chapterGuid, query) {
    var w = chapterWiring(files, chapterGuid); if (!w) return [];
    var q = (query || '').toLowerCase();
    return w.sparks.filter(function (s) { return s.name.toLowerCase().indexOf(q) !== -1; }).map(function (s) { return s.name; });
  }

  var api = { bookMap: bookMap, chapterWiring: chapterWiring, findSparks: findSparks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.BuilderDoctorMap = api;
})(typeof window !== 'undefined' ? window : globalThis);
