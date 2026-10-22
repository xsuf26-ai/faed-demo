(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FaedLogistics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_WEIGHTS = Object.freeze({ eta: 35, urgency: 25, capacity: 20, cost: 15, merge: 5 });
  const DEFAULT_POLICY = Object.freeze({
    urgentSlackMins: 30,
    highSlackMins: 120,
    urgencyHorizonMins: 240,
    etaHorizonMins: 360,
    costHorizonKm: 50,
    pickupServiceMins: 5,
    deliveryServiceMins: 10,
    maxStopsPerRoute: 8,
    maxRoutes: 8,
    maxEvaluations: 12000,
    maxWaitMins: 360,
  });

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const finite = n => Number.isFinite(Number(n));
  const asMs = v => v instanceof Date ? v.getTime() : (typeof v === "number" ? v : Date.parse(v));
  const totalKg = request => (request.items || []).reduce((sum, item) => sum + Number(item.kg || 0), 0);
  const coord = entity => {
    const c = entity?.coords || entity?.location?.coords || entity?.location;
    if (Array.isArray(c) && c.length >= 2) return [Number(c[0]), Number(c[1])];
    if (c && finite(c.lat) && finite(c.lng ?? c.lon)) return [Number(c.lat), Number(c.lng ?? c.lon)];
    return null;
  };
  const issue = (code, message) => ({ code, message });

  function validateRequest(request, now = Date.now()) {
    const issues = [];
    if (!request || !request.id) issues.push(issue("missing_id", "معرّف طلب الفائض مفقود."));
    if (!request?.name && !request?.facility?.name) issues.push(issue("missing_facility", "اسم المنشأة مفقود."));
    if (!request?.facilityType && !request?.facility?.type) issues.push(issue("missing_facility_type", "نوع المنشأة غير محدد."));
    if (!coord(request)) issues.push(issue("missing_location", "إحداثيات موقع الاستلام غير متاحة."));
    if (request?.state !== "open") issues.push(issue("not_open", "الطلب ليس في حالة مفتوحة للمطابقة."));
    const safety = request?.foodSafety;
    if (!safety || safety.notServed !== true || safety.verified !== true || !String(safety.evidenceRef || "").trim()) {
      issues.push(issue("safety_verification", "يتطلب التحقق من أن الطعام غير مقدم للضيوف وتوثيق سلامته قبل المطابقة."));
    }
    if (!Array.isArray(request?.items) || request.items.length === 0) {
      issues.push(issue("missing_items", "أضف صنفًا وكمية لكل نوع طعام."));
    } else {
      request.items.forEach((item, index) => {
        if (!item?.type || !finite(item.kg) || Number(item.kg) <= 0) issues.push(issue("invalid_item", `بيانات الصنف رقم ${index + 1} أو كميته غير مكتملة.`));
        if (!["hot", "cold", "ambient"].includes(item?.handling)) issues.push(issue("handling_unknown", `متطلبات حفظ الصنف ${item?.type || index + 1} غير محددة.`));
      });
    }
    const readyAt = asMs(request?.readyAt);
    const pickupBy = asMs(request?.pickupBy);
    const deliverBy = asMs(request?.deliverBy);
    const offerExpiresAt = request?.offerExpiresAt == null ? Infinity : asMs(request.offerExpiresAt);
    if (!Number.isFinite(readyAt) || !Number.isFinite(pickupBy) || !Number.isFinite(deliverBy)) {
      issues.push(issue("time_window_unknown", "نافذة الجاهزية وآخر موعد للاستلام والتسليم غير موثقة."));
    } else {
      if (readyAt > pickupBy || pickupBy > deliverBy) issues.push(issue("invalid_time_window", "ترتيب أوقات الجاهزية والموعد النهائي غير صالح."));
      if (deliverBy <= now) issues.push(issue("expired", "انتهت نافذة الطلب الزمنية."));
    }
    if (offerExpiresAt !== Infinity && (!Number.isFinite(offerExpiresAt) || offerExpiresAt <= now)) issues.push(issue("offer_expired", "انتهت صلاحية عرض الفائض أو أُلغي."));
    return { ok: issues.length === 0, issues, kg: totalKg(request), readyAt, pickupBy, deliverBy, offerExpiresAt };
  }

  function receivingCapacity(recipient) {
    const cap = Number(recipient?.capacityKg ?? recipient?.capacity);
    const load = Number(recipient?.currentLoadKg ?? 0);
    const perOperation = Number(recipient?.maxPerOperationKg ?? cap);
    if (!finite(cap) || cap < 0 || !finite(load) || load < 0 || !finite(perOperation) || perOperation < 0) return null;
    return Math.max(0, Math.min(cap - load, perOperation, finite(recipient?.remainingCapacityKg) ? Number(recipient.remainingCapacityKg) : Infinity));
  }

  function candidateRecipient(request, recipient, validation, now) {
    const reasons = [];
    if (recipient?.state !== "available" || recipient?.available !== true) reasons.push("الجهة غير متاحة أو حالتها غير مؤكدة.");
    if (!coord(recipient)) reasons.push("موقع الجهة غير متاح.");
    const capacity = receivingCapacity(recipient);
    if (capacity == null) reasons.push("السعة المتاحة غير موثقة.");
    else if (validation.kg > capacity) reasons.push(`الكمية ${validation.kg} كجم تتجاوز السعة المتاحة ${capacity} كجم؛ لا يُقسّم الطلب تلقائيًا.`);
    if (recipient?.confirmationAvailable !== true) reasons.push("آلية تأكيد الاستلام غير موثقة.");
    const acceptedFoods = recipient?.acceptedFoods ?? recipient?.accepts;
    if (!Array.isArray(acceptedFoods)) reasons.push("قائمة الأصناف المقبولة غير موثقة.");
    else for (const item of request.items || []) if (!acceptedFoods.includes(item.type)) reasons.push(`لا تقبل صنف ${item.type}.`);
    if (!Array.isArray(recipient?.storageTypes)) reasons.push("إمكانات الحفظ والتخزين غير موثقة.");
    else for (const item of request.items || []) if (!recipient.storageTypes.includes(item.handling)) reasons.push(`لا تتوفر لديها متطلبات حفظ ${item.type} (${item.handling}).`);
    const opensAt = asMs(recipient?.receivingFrom);
    const closesAt = asMs(recipient?.receivingUntil);
    if (!Number.isFinite(opensAt) || !Number.isFinite(closesAt)) reasons.push("ساعات استقبال الجهة غير موثقة.");
    else if (closesAt <= now) reasons.push("انتهت ساعات استقبال الجهة.");
    return { eligible: reasons.length === 0, reasons, remainingCapacityKg: capacity };
  }

  function candidateVehicle(request, vehicle, validation, now) {
    const reasons = [];
    if (vehicle?.state !== "available" || vehicle?.available !== true) reasons.push("المركبة غير متاحة أو مخصصة لمهمة أخرى.");
    if (!coord(vehicle)) reasons.push("موقع المركبة الحالي غير متاح.");
    const capacity = Number(vehicle?.capacityKg ?? vehicle?.capacity);
    const load = Number(vehicle?.currentLoadKg ?? 0);
    const remaining = Number(vehicle?.remainingCapacityKg ?? capacity - load);
    if (!finite(capacity) || capacity <= 0 || !finite(load) || load < 0 || !finite(remaining) || remaining < 0) reasons.push("سعة المركبة أو حمولتها الحالية غير موثقة.");
    else if (load > capacity || remaining > capacity - load + 1e-6) reasons.push("الحمولة الحالية أو السعة المتبقية تتعارض مع سعة المركبة المعلنة.");
    else if (validation.kg > remaining) reasons.push(`الحمولة ${validation.kg} كجم تتجاوز السعة المتبقية ${remaining} كجم.`);
    const availableAt = vehicle?.availableAt == null ? now : asMs(vehicle.availableAt);
    if (!Number.isFinite(availableAt)) reasons.push("وقت توفر المركبة القادم غير موثق.");
    else if (availableAt > validation.deliverBy) reasons.push("لن تتوفر المركبة قبل الموعد النهائي للطلب.");
    if (!Array.isArray(vehicle?.foodTypes)) reasons.push("أنواع الطعام التي تنقلها المركبة غير موثقة.");
    else for (const item of request.items || []) if (!vehicle.foodTypes.includes(item.type)) reasons.push(`المركبة غير مهيأة لنقل صنف ${item.type}.`);
    if (!Array.isArray(vehicle?.handlingTypes)) reasons.push("تجهيزات حفظ الحمولة في المركبة غير موثقة.");
    else for (const item of request.items || []) if (!vehicle.handlingTypes.includes(item.handling)) reasons.push(`المركبة لا تستوفي حفظ ${item.type} (${item.handling}).`);
    return { eligible: reasons.length === 0, reasons, remainingCapacityKg: Number.isFinite(remaining) ? remaining : 0, availableAt };
  }

  function matrixValue(matrix, from, to, key) {
    const i = matrix?.nodeIndex?.[from], j = matrix?.nodeIndex?.[to];
    if (!Number.isInteger(i) || !Number.isInteger(j)) return null;
    const v = matrix?.[key]?.[i]?.[j];
    return finite(v) && Number(v) >= 0 ? Number(v) : null;
  }

  function routeValidOrder(stops) {
    const picked = new Set();
    for (const stop of stops) {
      if (stop.kind === "pickup") picked.add(stop.requestId);
      if (stop.kind === "delivery" && !picked.has(stop.requestId)) return false;
    }
    return true;
  }

  function evaluateRoute(vehicle, stops, assignments, matrix, now, policy) {
    if (stops.length > policy.maxStopsPerRoute || !routeValidOrder(stops)) return { feasible: false, reasons: ["ترتيب المحطات يتجاوز الحد أو يضع التسليم قبل الاستلام."] };
    let time = Math.max(now, asMs(vehicle.availableAt ?? now));
    let load = Number(vehicle.currentLoadKg ?? 0), maxLoad = load, distanceM = 0, driveSec = 0;
    const completed = new Map(), pickupTimes = new Map(), deliveries = new Map(), timeline = [];
    const allAssignments = new Map(assignments.map(a => [a.request.id, a]));
    let currentNode = vehicle.id;
    for (const stop of stops) {
      const mins = matrixValue(matrix, currentNode, stop.nodeId, "durations");
      const meters = matrixValue(matrix, currentNode, stop.nodeId, "distances");
      if (mins == null || meters == null) return { feasible: false, reasons: ["مزود المسارات لا يملك زمنًا أو مسافة لهذا المسار."] };
      driveSec += mins; distanceM += meters; time += mins * 1000;
      const assignment = allAssignments.get(stop.requestId);
      if (!assignment) return { feasible: false, reasons: ["تعذر ربط محطة بطلبها."] };
      if (stop.kind === "pickup") {
        const req = assignment.request, readyAt = asMs(req.readyAt), by = asMs(req.pickupBy);
        time = Math.max(time, readyAt);
        if (time > by) return { feasible: false, reasons: [`الوصول لاستلام ${req.name} يتجاوز آخر وقت للاستلام.`] };
        load += totalKg(req); maxLoad = Math.max(maxLoad, load);
        if (load > Number(vehicle.capacityKg ?? vehicle.capacity) + 1e-6) return { feasible: false, reasons: [`حمولة ${load} كجم تتجاوز سعة المركبة.`] };
        pickupTimes.set(req.id, time);
        time += policy.pickupServiceMins * 60000;
        timeline.push({ kind: "pickup", requestId: req.id, name: req.name, at: time, loadKg: load });
      } else {
        const recipient = assignment.recipient;
        const opens = asMs(recipient.receivingFrom), closes = asMs(recipient.receivingUntil);
        time = Math.max(time, opens);
        if (time > closes) return { feasible: false, reasons: [`الوصول إلى ${recipient.name} يقع خارج ساعات الاستقبال.`] };
        time += policy.deliveryServiceMins * 60000;
        if (time > asMs(assignment.request.deliverBy)) return { feasible: false, reasons: [`تسليم ${assignment.request.name} يتجاوز الموعد النهائي.`] };
        load -= totalKg(assignment.request);
        if (load < -1e-6) return { feasible: false, reasons: ["تسلسل الحمولة غير صالح."] };
        deliveries.set(assignment.request.id, time);
        completed.set(assignment.request.id, time);
        timeline.push({ kind: "delivery", requestId: assignment.request.id, name: recipient.name, at: time, loadKg: Math.max(0, load) });
      }
      currentNode = stop.nodeId;
    }
    const endAt = time, driveMins = driveSec / 60, waitAndServiceMins = Math.max(0, (endAt - now) / 60000 - driveMins);
    return { feasible: true, distanceM, driveSec, driveMins, elapsedMins: (endAt - now) / 60000, waitAndServiceMins, endAt, maxLoadKg: maxLoad, timeline, pickupTimes, deliveries, completionByRequest: completed };
  }

  function optimize2Opt(vehicle, stops, assignments, matrix, now, policy) {
    let current = stops.map(s => ({ ...s }));
    let evaluated = evaluateRoute(vehicle, current, assignments, matrix, now, policy);
    if (!evaluated.feasible || current.length < 4) return { stops: current, evaluation: evaluated, improved: false };
    let changed = true, improved = false, guard = 0;
    while (changed && guard++ < current.length * 2) {
      changed = false;
      for (let i = 0; i < current.length - 1 && !changed; i++) for (let k = i + 1; k < current.length; k++) {
        const candidate = [...current.slice(0, i), ...current.slice(i, k + 1).reverse(), ...current.slice(k + 1)].map(s => ({ ...s }));
        if (!routeValidOrder(candidate)) continue;
        const next = evaluateRoute(vehicle, candidate, assignments, matrix, now, policy);
        if (next.feasible && next.distanceM + 1 < evaluated.distanceM) { current = candidate; evaluated = next; changed = improved = true; break; }
      }
    }
    return { stops: current, evaluation: evaluated, improved };
  }

  function insertStopPair(vehicle, route, assignment, matrix, now, policy, budget) {
    const oldStops = route?.stops || [];
    const oldAssignments = route?.assignments || [];
    if (oldAssignments.some(a => a.request.id === assignment.request.id)) return { feasible: false, reasons: ["الطلب مكرر في رحلة المركبة."] };
    const candidateAssignments = [...oldAssignments, assignment];
    let best = null;
    for (let p = 0; p <= oldStops.length; p++) {
      for (let d = p + 1; d <= oldStops.length + 1; d++) {
        if (++budget.count > policy.maxEvaluations) break;
        const stops = oldStops.map(s => ({ ...s }));
        stops.splice(p, 0, { kind: "pickup", requestId: assignment.request.id, nodeId: assignment.request.id });
        stops.splice(d, 0, { kind: "delivery", requestId: assignment.request.id, nodeId: assignment.recipient.id });
        const evaluated = evaluateRoute(vehicle, stops, candidateAssignments, matrix, now, policy);
        if (!evaluated.feasible) continue;
        const optimized = optimize2Opt(vehicle, stops, candidateAssignments, matrix, now, policy);
        const result = { stops: optimized.stops, assignments: candidateAssignments, evaluation: optimized.evaluation, improved2Opt: optimized.improved };
        const baseline = route?.evaluation?.distanceM || 0;
        result.incrementalDistanceM = result.evaluation.distanceM - baseline;
        result.incrementalMins = result.evaluation.elapsedMins - (route?.evaluation?.elapsedMins || 0);
        if (!best || result.evaluation.distanceM < best.evaluation.distanceM || (result.evaluation.distanceM === best.evaluation.distanceM && result.evaluation.endAt < best.evaluation.endAt)) best = result;
      }
      if (budget.count > policy.maxEvaluations) break;
    }
    return best || { feasible: false, reasons: ["لا يوجد إدراج صالح يحافظ على ترتيب الاستلام والتسليم والسعة والنوافذ الزمنية."] };
  }

  function scoreCandidate(candidate, requestValidation, vehicle, wasMerged, policy, weights) {
    const etaMins = candidate.evaluation.elapsedMins;
    const completionSlack = Math.max(0, (requestValidation.deliverBy - candidate.evaluation.completionByRequest.get(candidate.request.id)) / 60000);
    const eta = clamp(100 * (1 - etaMins / policy.etaHorizonMins), 0, 100);
    const urgency = clamp(100 * (1 - completionSlack / policy.urgencyHorizonMins), 0, 100);
    const capacity = clamp(100 * candidate.evaluation.maxLoadKg / Number(vehicle.capacityKg ?? vehicle.capacity), 0, 100);
    const cost = clamp(100 * (1 - candidate.incrementalDistanceM / (policy.costHorizonKm * 1000)), 0, 100);
    const merge = wasMerged ? 100 : 0;
    const score = (eta * weights.eta + urgency * weights.urgency + capacity * weights.capacity + cost * weights.cost + merge * weights.merge) / 100;
    return { score, components: { eta, urgency, capacity, cost, merge }, completionSlackMins: completionSlack, etaMins };
  }

  function plan({ requests = [], recipients = [], vehicles, drivers, matrix, now = Date.now(), policy = {}, weights = {} } = {}) {
    const currentTime = asMs(now), config = { ...DEFAULT_POLICY, ...policy }, factor = { ...DEFAULT_WEIGHTS, ...weights };
    const fleet = vehicles || drivers || [];
    const all = { requests: [], assignments: [], routes: [], unmatched: [], needsVerification: [], decisions: [], usedApproximateRoutes: matrix?.source === "haversine-estimate" };
    if (!Number.isFinite(currentTime)) throw new TypeError("now must be a valid timestamp");
    if (!matrix || !Array.isArray(matrix.durations) || !Array.isArray(matrix.distances) || !matrix.nodeIndex) throw new TypeError("A routing matrix with durations, distances and nodeIndex is required");

    const validated = requests.map(request => ({ request, validation: validateRequest(request, currentTime) }));
    const pending = [];
    for (const entry of validated) {
      const { request, validation } = entry;
      const decision = { requestId: request.id, requestName: request.name, priority: null, reasons: [], candidates: [] };
      all.decisions.push(decision);
      if (!validation.ok) {
        decision.reasons = validation.issues.map(x => x.message);
      if (validation.issues.some(x => x.code === "safety_verification" || x.code === "handling_unknown" || x.code === "time_window_unknown")) all.needsVerification.push({ requestId: request.id, name: request.name, reasons: decision.reasons });
        else all.unmatched.push({ requestId: request.id, name: request.name, reasons: decision.reasons });
      } else pending.push({ ...entry, decision });
    }
    pending.sort((a, b) => a.validation.deliverBy - b.validation.deliverBy || a.validation.pickupBy - b.validation.pickupBy || b.validation.kg - a.validation.kg);

    const vehicleStatus = fleet.map(v => ({ vehicle: v, reasons: v.state !== "available" || v.available !== true ? ["المركبة غير متاحة أو حالتها غير مؤكدة."] : [] }));
    const routes = new Map();
    const recipientUsed = new Map(recipients.map(r => [r.id, Number(r.currentLoadKg || 0)]));
    const assignedRequestIds = new Set();
    const budget = { count: 0 };

    for (const entry of pending) {
      const { request, validation, decision } = entry;
      if (assignedRequestIds.has(request.id)) {
        decision.reasons = ["معرّف الطلب مكرر في بيانات المختبر؛ لم يُنشأ له تعيين ثانٍ."];
        all.unmatched.push({ requestId: request.id, name: request.name, reasons: decision.reasons });
        continue;
      }
      const slack = (validation.deliverBy - currentTime) / 60000;
      decision.priority = slack <= config.urgentSlackMins ? "urgent" : slack <= config.highSlackMins ? "high" : "normal";
      const possible = [];
      for (const recipient of recipients) {
        const remainingNow = recipientUsed.has(recipient.id) ? (receivingCapacity(recipient) ?? 0) - (recipientUsed.get(recipient.id) - Number(recipient.currentLoadKg || 0)) : 0;
        const rValidation = candidateRecipient(request, recipient, validation, currentTime);
        if (rValidation.eligible && validation.kg > remainingNow) {
          rValidation.eligible = false;
          rValidation.reasons.push(`السعة المتبقية بعد المطابقات السابقة ${Math.max(0, remainingNow)} كجم בלבד.`);
        }
        const recipientDecision = { recipientId: recipient.id, recipientName: recipient.name, eligible: rValidation.eligible, reasons: [...rValidation.reasons] };
        decision.candidates.push(recipientDecision);
        if (!rValidation.eligible) continue;
        for (const state of vehicleStatus) {
          const vehicle = state.vehicle, vValidation = candidateVehicle(request, vehicle, validation, currentTime);
          const vd = { vehicleId: vehicle.id, vehicleName: vehicle.name, eligible: vValidation.eligible, reasons: [...vValidation.reasons] };
          recipientDecision.vehicles ||= []; recipientDecision.vehicles.push(vd);
          if (!vValidation.eligible || !coord(vehicle)) continue;
          const currentRoute = routes.get(vehicle.id) || null;
          if (!currentRoute && routes.size >= config.maxRoutes) { vd.eligible = false; vd.reasons.push("تم بلوغ حد عدد الرحلات في هذا التحليل."); continue; }
          const assignment = { request, recipient, vehicle, quantityKg: validation.kg };
          const inserted = insertStopPair(vehicle, currentRoute, assignment, matrix, currentTime, config, budget);
          if (!inserted.evaluation) { vd.eligible = false; vd.reasons.push(...inserted.reasons); continue; }
          const merged = inserted.assignments.length > 1;
          const scored = scoreCandidate({ ...inserted, request }, validation, vehicle, merged, config, factor);
          possible.push({ ...inserted, request, recipient, vehicle, score: scored.score, scoreComponents: scored.components, completionSlackMins: scored.completionSlackMins, etaMins: scored.etaMins, merged });
        }
      }
      if (!possible.length) {
        const reasons = decision.candidates.flatMap(c => [...c.reasons, ...(c.vehicles || []).flatMap(v => v.reasons)]);
        decision.reasons = [...new Set(reasons)].slice(0, 8);
        all.unmatched.push({ requestId: request.id, name: request.name, priority: decision.priority, reasons: decision.reasons.length ? decision.reasons : ["لم يتم العثور على جمعية ومركبة مؤهلتين ضمن القيود."] });
        continue;
      }
      possible.sort((a, b) => b.score - a.score || a.evaluation.distanceM - b.evaluation.distanceM);
      const winner = possible[0];
      const route = { vehicle: winner.vehicle, stops: winner.stops, assignments: winner.assignments, evaluation: winner.evaluation, improved2Opt: winner.improved2Opt, source: matrix.source || "unknown" };
      routes.set(winner.vehicle.id, route);
      assignedRequestIds.add(request.id);
      recipientUsed.set(winner.recipient.id, recipientUsed.get(winner.recipient.id) + validation.kg);
      const alternatives = possible.slice(1).map(c => ({ recipientId: c.recipient.id, recipientName: c.recipient.name, vehicleId: c.vehicle.id, vehicleName: c.vehicle.name, score: round(c.score), reasons: [`البديل صالح لكنه أقل ترتيبًا (درجة ${round(c.score)} من 100).`] }));
      decision.selected = { recipientId: winner.recipient.id, recipientName: winner.recipient.name, vehicleId: winner.vehicle.id, vehicleName: winner.vehicle.name, score: round(winner.score), scoreComponents: Object.fromEntries(Object.entries(winner.scoreComponents).map(([k, v]) => [k, round(v)])), completionSlackMins: round(winner.completionSlackMins), etaMins: round(winner.etaMins), reasons: ["الجهة متاحة وتقبل الأصناف المحددة ولديها سعة وتجهيزات استقبال موثقة.", "المركبة متاحة وتفي بالسعة والتجهيزات، والمسار يحقق نافذتي الاستلام والتسليم.", winner.merged ? "أُدرج الطلب ضمن رحلة قائمة دون كسر قيودها." : "أُنشئت رحلة مستقلة للمركبة."] };
      decision.alternatives = alternatives;
      all.assignments.push({ requestId: request.id, recipientId: winner.recipient.id, vehicleId: winner.vehicle.id, quantityKg: validation.kg, score: round(winner.score), priority: decision.priority, state: "suggested-needs-confirmation", reasons: decision.selected.reasons });
    }

    all.routes = [...routes.values()].map(route => ({
      vehicleId: route.vehicle.id, vehicleName: route.vehicle.name, vehicleCapacityKg: Number(route.vehicle.capacityKg ?? route.vehicle.capacity), vehicleCurrentLoadKg: Number(route.vehicle.currentLoadKg || 0), remainingCapacityKg: Number(route.vehicle.capacityKg ?? route.vehicle.capacity) - Number(route.vehicle.currentLoadKg || 0) - route.assignments.reduce((s, a) => s + a.quantityKg, 0),
      assignments: route.assignments.map(a => ({ requestId: a.request.id, requestName: a.request.name, recipientId: a.recipient.id, recipientName: a.recipient.name, quantityKg: a.quantityKg, items: a.request.items })),
      stops: route.stops.map(s => ({ kind: s.kind, requestId: s.requestId, nodeId: s.nodeId, name: s.kind === "pickup" ? route.assignments.find(a => a.request.id === s.requestId)?.request.name : route.assignments.find(a => a.request.id === s.requestId)?.recipient.name, eta: new Date(route.evaluation.timeline.find(t => t.kind === s.kind && t.requestId === s.requestId)?.at || route.evaluation.endAt).toISOString() })),
      distanceM: round(route.evaluation.distanceM), driveMins: round(route.evaluation.driveMins), elapsedMins: round(route.evaluation.elapsedMins), maxLoadKg: round(route.evaluation.maxLoadKg), optimized2Opt: route.improved2Opt, source: route.source,
      state: "calculated-needs-confirmation",
    }));
    all.unmatched = uniqueById(all.unmatched);
    all.needsVerification = uniqueById(all.needsVerification);
    all.requests = all.decisions.map(d => ({ requestId: d.requestId, name: d.requestName, priority: d.priority, status: d.selected ? "matched-needs-confirmation" : (all.needsVerification.some(x => x.requestId === d.requestId) ? "needs-verification" : "unmatched"), selectedAssociationId: d.selected?.recipientId || null, assignedVehicleId: d.selected?.vehicleId || null, reasons: d.selected?.reasons || d.reasons }));
    all.evaluations = budget.count;
    all.weights = factor;
    all.policy = config;
    return all;
  }

  function uniqueById(list) { const seen = new Set(); return list.filter(x => { if (seen.has(x.requestId)) return false; seen.add(x.requestId); return true; }); }
  function round(n) { return Math.round(Number(n) * 10) / 10; }

  function haversineMatrix(points, { roadFactor = 1.25, speedKmh = 25 } = {}) {
    const nodeIndex = Object.fromEntries(points.map((p, i) => [p.id, i]));
    const durations = [], distances = [];
    for (const a of points) {
      const rowD = [], rowT = [];
      for (const b of points) {
        const ca = coord(a), cb = coord(b);
        if (!ca || !cb) { rowD.push(null); rowT.push(null); continue; }
        const rad = Math.PI / 180, dLat = (cb[0] - ca[0]) * rad, dLon = (cb[1] - ca[1]) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(ca[0] * rad) * Math.cos(cb[0] * rad) * Math.sin(dLon / 2) ** 2;
        const meters = 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * roadFactor;
        rowD.push(meters); rowT.push(meters / (speedKmh * 1000 / 3600));
      }
      distances.push(rowD); durations.push(rowT);
    }
    return { nodeIndex, durations, distances, source: "haversine-estimate", warning: "تقدير تقريبي من المسافة الجوية؛ ليس زمن قيادة أو مسار طرق فعليًا." };
  }

  function createOsrmProvider({ fetchImpl = typeof fetch === "function" ? fetch.bind(globalThis) : null, baseUrl = "https://router.project-osrm.org", timeoutMs = 15000 } = {}) {
    if (!fetchImpl) throw new Error("fetch is unavailable");
    async function json(path) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}${path}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`OSRM HTTP ${response.status}`);
        const body = await response.json();
        if (body.code !== "Ok") throw new Error(`OSRM ${body.code || "invalid response"}`);
        return body;
      } finally { clearTimeout(timer); }
    }
    const coordinates = points => points.map(p => { const c = coord(p); if (!c) throw new Error(`Missing coordinates for ${p.id}`); return `${c[1]},${c[0]}`; }).join(";");
    return {
      source: "OSRM public routing service",
      async matrix(points) {
        const body = await json(`/table/v1/driving/${coordinates(points)}?annotations=duration,distance`);
        if (!Array.isArray(body.durations) || !Array.isArray(body.distances)) throw new Error("OSRM table has no durations or distances");
        return { nodeIndex: Object.fromEntries(points.map((p, i) => [p.id, i])), durations: body.durations, distances: body.distances, source: "OSRM public routing service" };
      },
      async route(points) {
        const body = await json(`/route/v1/driving/${coordinates(points)}?overview=full&geometries=geojson&steps=false`);
        if (!Array.isArray(body.routes) || !body.routes.length || !body.routes[0].geometry) throw new Error("OSRM route has no geometry");
        return body.routes[0];
      },
    };
  }

  return { DEFAULT_WEIGHTS, DEFAULT_POLICY, validateRequest, candidateRecipient, candidateVehicle, evaluateRoute, optimize2Opt, plan, haversineMatrix, createOsrmProvider, totalKg, coord };
});
