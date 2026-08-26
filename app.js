(() => {
  "use strict";

  const DB_KEY = "riftbound-collection-database";
  const CATALOG_KEY = "riftbound-card-catalog-cache-v1";
  const CHECK_KEY = "riftbound-card-catalog-last-check";
  const API = "https://api.riftcodex.com";
  const APP_VERSION = 3;
  const AUTH_ME_PATH = "/api/v1/auth/me";
  const COLLECTION_PATH = "/api/v1/binder-atlas/collection";
  const LOGIN_URL = "https://ezstudycards.com/app?next=https://binderatlas.ezstudycards.com/";

  const BINDER_DEFINITIONS = [
    { id: "OGN", label: "Origins + Proving Grounds", sources: ["OGN", "OGS"], rows: 3, format: "VaultX 4×3" },
    { id: "SFD", label: "Spiritforged", sources: ["SFD"], rows: 3, format: "VaultX 4×3" },
    { id: "UNL", label: "Unleashed", sources: ["UNL"], rows: 3, format: "VaultX 4×3" },
    { id: "VEN", label: "Vendetta", sources: ["VEN"], rows: 3, format: "VaultX 4×3" },
    { id: "PROMOS", label: "Promos · PR / OPP / JDG", sources: ["PR", "OPP", "JDG"], rows: 4, format: "4×4 promo binder" }
  ];

  const $ = id => document.getElementById(id);
  const elements = {
    binderSelect: $("binderSelect"), binderMeta: $("binderMeta"), updateBanner: $("updateBanner"),
    percentStat: $("percentStat"), progressBar: $("progressBar"), collectedStat: $("collectedStat"), portfolioStat: $("portfolioStat"),
    missingStat: $("missingStat"), orderedStat: $("orderedStat"), sectionStats: $("sectionStats"),
    searchForm: $("searchForm"), searchInput: $("searchInput"), searchResults: $("searchResults"),
    searchScopeCurrent: $("searchScopeCurrent"), searchScopeAll: $("searchScopeAll"),
    cardDetail: $("cardDetail"), detailImage: $("detailImage"), detailFallback: $("detailFallback"), detailId: $("detailId"),
    detailSection: $("detailSection"), detailName: $("detailName"), detailLocation: $("detailLocation"),
    markCollected: $("markCollected"), markOrdered: $("markOrdered"), markMissing: $("markMissing"),
    undoButton: $("undoButton"), packModeButton: $("packModeButton"), shoppingButton: $("shoppingButton"),
    layoutButton: $("layoutButton"), moreButton: $("moreButton"), saveStatus: $("saveStatus"), accountStatus: $("accountStatus"), storageNote: $("storageNote"),
    previousSpread: $("previousSpread"), nextSpread: $("nextSpread"), binderPrevious: $("binderPrevious"), binderNext: $("binderNext"), spreadTitle: $("spreadTitle"),
    spreadSubtitle: $("spreadSubtitle"), sectionNav: $("sectionNav"), missingOnly: $("missingOnly"),
    pageJump: $("pageJump"), binderStage: $("binderStage"), leftPageLabel: $("leftPageLabel"),
    rightPageLabel: $("rightPageLabel"), leftSectionLabel: $("leftSectionLabel"),
    rightSectionLabel: $("rightSectionLabel"), leftGrid: $("leftGrid"), rightGrid: $("rightGrid"),
    packDialog: $("packDialog"), packInput: $("packInput"), packMatches: $("packMatches"), packRecent: $("packRecent"),
    layoutDialog: $("layoutDialog"), layoutSummary: $("layoutSummary"), layoutChanges: $("layoutChanges"),
    downloadLayout: $("downloadLayout"), acceptLayout: $("acceptLayout"), dataDialog: $("dataDialog"),
    catalogStatus: $("catalogStatus"), syncButton: $("syncButton"), exportButton: $("exportButton"),
    importInput: $("importInput"), toast: $("toast"),
    previewDialog: $("previewDialog"), previewImage: $("previewImage"), previewMeta: $("previewMeta"),
    previewName: $("previewName"), previewStatus: $("previewStatus"), previewCollected: $("previewCollected")
  };

  const mobileMedia = window.matchMedia("(max-width: 780px)");

  let catalog = sanitizeCatalog(chooseCatalog());
  let database = loadDatabase();
  let activeBinderId = database.preferences?.activeBinder || "SFD";
  let currentCards = [];
  let currentSpread = 1;
  let currentMobilePage = 1;
  let selectedKey = null;
  let undoStack = [];
  let packRecent = [];
  let toastTimer;
  let cloudSaveTimer;
  let cloudSyncEnabled = false;

  function chooseCatalog() {
    const embedded = window.RIFTBOUND_SNAPSHOT;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CATALOG_KEY) || "null"); } catch {}
    if (!embedded && !cached) return { schemaVersion: 1, generatedAt: null, sets: [], cards: [] };
    if (!embedded) return cached;
    if (!cached) return embedded;
    return new Date(cached.generatedAt) > new Date(embedded.generatedAt) ? cached : embedded;
  }

  function sanitizeCatalog(input) {
    const cards = input.cards || [];
    const preferredByPrinting = new Set();
    for (const card of cards) {
      if (!card.isNew && card.tcgplayerId) preferredByPrinting.add(`${card.setId}|${card.code}|${card.image}`);
    }
    let cleaned = cards.filter(card => !(card.isNew && !card.tcgplayerId && preferredByPrinting.has(`${card.setId}|${card.code}|${card.image}`)));

    // Vendetta launched before public APIs exposed its confirmed signature treatments.
    // Reserve the nine known Legend signatures now; a later sync replaces these
    // placeholders by printed code without moving saved collection progress.
    const vendettaSignatures = new Set(cleaned.filter(card => card.setId === "VEN" && isSignature(card)).map(card => card.number));
    for (let number = 189; number <= 197; number += 1) {
      if (vendettaSignatures.has(number)) continue;
      const overnumber = cleaned.find(card => card.setId === "VEN" && card.number === number && isOvernumbered(card));
      if (!overnumber) continue;
      cleaned.push({
        ...overnumber,
        id: `VEN-SIGNATURE-PLACEHOLDER-${number}`,
        code: String(overnumber.code).replace(/-(\d+)-/, "-$1*-"),
        tcgplayerId: null,
        name: overnumber.name.replace(/\s*\(Overnumbered\)\s*$/i, "") + " (Signature)",
        signature: true,
        overnumbered: false,
        synthetic: true,
        isNew: false
      });
    }
    return { ...input, cards: cleaned };
  }

  function blankBinder() {
    return { statuses: {}, layout: [], layoutSavedAt: null, updatedAt: null };
  }

  function blankDatabase() {
    const binders = {};
    BINDER_DEFINITIONS.forEach(binder => { binders[binder.id] = blankBinder(); });
    return {
      schemaVersion: APP_VERSION,
      binders,
      preferences: { activeBinder: "SFD", missingOnly: false },
      createdAt: new Date().toISOString(),
      updatedAt: null
    };
  }

  function loadDatabase() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(DB_KEY) || "null"); } catch {}
    if (!stored) return blankDatabase();
    if (stored.schemaVersion >= 2 && stored.binders) return upgradeDatabase(stored);
    return migrateVersionOne(stored);
  }

  function upgradeDatabase(stored) {
    stored.binders ||= {};
    stored.preferences ||= { activeBinder: "SFD", missingOnly: false };
    if (stored.schemaVersion < 3) {
      const origins = stored.binders.OGN ||= blankBinder();
      const provingGrounds = stored.binders.OGS;
      origins.statuses ||= {};
      origins.layout ||= [];
      if (provingGrounds) {
        Object.assign(origins.statuses, provingGrounds.statuses || {});
        const combinedKeys = [
          ...origins.layout.map(entry => entry.key),
          ...(provingGrounds.layout || []).map(entry => entry.key)
        ];
        if (combinedKeys.length) {
          origins.layout = combinedKeys.map((key, index) => ({ key, ...storedLocationFor(index, 12) }));
          origins.layoutSavedAt = new Date().toISOString();
        }
        delete stored.binders.OGS;
      }
      if (stored.preferences.activeBinder === "OGS") stored.preferences.activeBinder = "OGN";
      stored.migratedFrom = stored.schemaVersion;
    }
    BINDER_DEFINITIONS.forEach(binder => {
      stored.binders[binder.id] ||= blankBinder();
      stored.binders[binder.id].statuses ||= {};
      stored.binders[binder.id].layout ||= [];
    });
    stored.schemaVersion = APP_VERSION;
    return stored;
  }

  function storedLocationFor(index, perPage) {
    const page = Math.floor(index / perPage) + 1;
    const slot = index % perPage + 1;
    return { index, page, slot, spread: Math.floor(page / 2) + 1, side: page % 2 === 0 ? "left" : "right" };
  }

  function migrateVersionOne(oldDatabase) {
    const next = blankDatabase();
    const oldSet = oldDatabase.sets?.spiritforged || oldDatabase.sets?.SFD;
    if (!oldSet?.statuses) return next;
    const sfdCards = catalog.cards.filter(card => card.setId === "SFD");
    for (const [legacyId, legacyStatus] of Object.entries(oldSet.statuses)) {
      const card = matchLegacySpiritforgedCard(legacyId, sfdCards);
      if (!card || !["collected", "ordered"].includes(legacyStatus)) continue;
      next.binders.SFD.statuses[cardKey(card)] = { status: legacyStatus, quantity: legacyStatus === "collected" ? 1 : 0 };
    }
    next.migratedFrom = 1;
    return next;
  }

  function matchLegacySpiritforgedCard(value, cards) {
    const id = String(value).trim().toUpperCase();
    const tokenNames = { "TOKEN-MECH": "MECH", "TOKEN-SAND-SOLDIER": "SAND SOLDIER", "TOKEN-GOLD": "GOLD" };
    if (tokenNames[id]) return cards.find(card => isToken(card) && normalize(card.name).includes(tokenNames[id]));
    const runeMatch = id.match(/^R(\d+)(A)?$/);
    if (runeMatch) {
      const number = Number(runeMatch[1]);
      return cards.filter(isRune).sort(compareCards).find(card => card.number === number && Boolean(card.alt) === Boolean(runeMatch[2]));
    }
    const altMatch = id.match(/^(\d+)A$/);
    if (altMatch) return cards.find(card => card.number === Number(altMatch[1]) && isAlternate(card) && !isOvernumbered(card) && !isSignature(card));
    const signatureMatch = id.match(/^(\d+)\*$/);
    if (signatureMatch) return cards.find(card => card.number === Number(signatureMatch[1]) && isSignature(card));
    if (/^\d+$/.test(id)) {
      const number = Number(id);
      return cards.find(card => card.number === number && (number > 221 ? isOvernumbered(card) : !isAlternate(card) && !isOvernumbered(card) && !isSignature(card) && !isToken(card) && !isRune(card)));
    }
    return null;
  }

  function isProductionHost() {
    const host = location.hostname;
    return host === "binderatlas.ezstudycards.com" || host === "ezstudycards.com";
  }

  function unwrapApiPayload(payload) {
    if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "success") && Object.prototype.hasOwnProperty.call(payload, "data")) {
      return payload.data;
    }
    return payload;
  }

  function collectionDocumentFromPayload(payload) {
    const unwrapped = unwrapApiPayload(payload);
    if (!unwrapped || typeof unwrapped !== "object") return null;
    const doc = unwrapped.database && (unwrapped.database.binders || unwrapped.database.sets) ? unwrapped.database : unwrapped;
    if (doc.binders || doc.sets) return doc;
    return null;
  }

  function databaseHasCollection(db) {
    if (!db?.binders) return false;
    return Object.values(db.binders).some(binder => Object.keys(binder?.statuses || {}).length || (binder?.layout || []).length);
  }

  function adoptDatabase(incoming) {
    database = incoming.schemaVersion >= 2 ? upgradeDatabase(incoming) : migrateVersionOne(incoming);
    activeBinderId = database.preferences?.activeBinder || "SFD";
    undoStack = [];
  }

  function accountEmail(me) {
    return me?.email || me?.user?.email || "";
  }

  function redirectToLogin() {
    location.href = LOGIN_URL;
  }

  function setSaveStatus(message) {
    elements.saveStatus.textContent = `${message} · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  function saveDatabase(message = "Saved locally") {
    database.updatedAt = new Date().toISOString();
    database.preferences.activeBinder = activeBinderId;
    database.preferences.missingOnly = elements.missingOnly.checked;
    localStorage.setItem(DB_KEY, JSON.stringify(database));
    const localMessage = isProductionHost() && message === "Saved locally" ? "Saved" : message;
    setSaveStatus(localMessage);
    if (cloudSyncEnabled) scheduleCloudSave();
  }

  function scheduleCloudSave() {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(() => { putCollectionToServer(); }, 500);
  }

  async function apiFetch(path, options = {}) {
    return fetch(path, {
      credentials: "include",
      ...options,
      headers: { Accept: "application/json", ...(options.headers || {}) }
    });
  }

  async function fetchAuthMe() {
    const response = await apiFetch(AUTH_ME_PATH);
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return unwrapApiPayload(await response.json());
  }

  async function getCollectionFromServer() {
    const response = await apiFetch(COLLECTION_PATH);
    if (response.status === 401 || response.status === 403) return { redirected: true };
    if (response.status === 404) return { document: null };
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    return { document: collectionDocumentFromPayload(payload) };
  }

  async function putCollectionToServer() {
    try {
      const response = await apiFetch(COLLECTION_PATH, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(database)
      });
      if (response.status === 401 || response.status === 403) {
        redirectToLogin();
        return false;
      }
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      setSaveStatus("Saved to account");
      return true;
    } catch (error) {
      console.error(error);
      setSaveStatus("Saved locally · cloud sync failed");
      return false;
    }
  }

  function showSignedIn(me) {
    const email = accountEmail(me);
    if (!elements.accountStatus) return;
    elements.accountStatus.hidden = false;
    elements.accountStatus.textContent = email ? `Signed in as ${email}` : "Signed in";
  }

  function applyHostedCopy() {
    if (!elements.storageNote) return;
    elements.storageNote.textContent = "Progress is saved to your EZ Study Cards account and cached in this browser. Export a backup if you want an extra copy.";
  }

  async function syncHostedCollection() {
    if (!isProductionHost()) return true;
    const me = await fetchAuthMe();
    if (!me) {
      redirectToLogin();
      return false;
    }
    showSignedIn(me);
    applyHostedCopy();
    try {
      const result = await getCollectionFromServer();
      if (result.redirected) {
        redirectToLogin();
        return false;
      }
      if (result.document) {
        adoptDatabase(result.document);
        localStorage.setItem(DB_KEY, JSON.stringify(database));
        setSaveStatus("Loaded from account");
      } else if (databaseHasCollection(database)) {
        await putCollectionToServer();
      }
    } catch (error) {
      console.error(error);
      showToast("Could not load your saved collection; using this browser's copy");
    }
    cloudSyncEnabled = true;
    return true;
  }

  function normalize(value) {
    return String(value ?? "").toUpperCase().normalize("NFKD").replace(/[^A-Z0-9]+/g, " ").trim();
  }

  function cardKey(card) {
    if (isSignature(card)) return `${card.setId}:CODE:${String(card.code).toUpperCase()}`;
    if (card.tcgplayerId) return `${card.setId}:TCG:${card.tcgplayerId}:${String(card.code).toUpperCase()}`;
    const variant = isOvernumbered(card) ? "OVER" : isAlternate(card) ? "ALT" : isToken(card) ? "TOKEN" : isRune(card) ? "RUNE" : isSpecial(card) ? "SPECIAL" : "BASE";
    return `${card.setId}:${card.code || card.id}:${variant}:${normalize(card.name)}`;
  }

  function isSignature(card) {
    return Boolean(card.signature) || /\*/.test(card.code || "");
  }

  function isAlternate(card) {
    return Boolean(card.alt) || /-\d+[a-z]-\d+$/i.test(card.code || "");
  }

  function isOvernumbered(card) {
    if (isSignature(card)) return false;
    if (card.overnumbered) return true;
    const match = String(card.code || "").match(/-(\d+)-(\d+)$/);
    return Boolean(match && Number(match[1]) > Number(match[2]));
  }

  function isToken(card) {
    return normalize(card.supertype) === "TOKEN" || /-T\d+/i.test(card.code || "");
  }

  function isRune(card) {
    return normalize(card.type) === "RUNE" || /-R\d+/i.test(card.code || "") || / RUNE$/.test(normalize(card.name));
  }

  function isSeparateRuneSeries(card) {
    return isRune(card) && /-R\d+/i.test(card.code || "");
  }

  function isSpecial(card) {
    return /-SP\d+/i.test(card.code || "");
  }

  function sectionFor(card, binderId = activeBinderId) {
    if (binderId === "PROMOS") {
      if (card.setId === "PR") return "Promos (PR)";
      if (card.setId === "OPP") return "Organized Play (OPP)";
      return "Judge (JDG)";
    }
    if (binderId === "OGN" && card.setId === "OGS") return "Proving Grounds (OGS)";
    if (isSignature(card) || isOvernumbered(card)) return "Overnumbered + signatures";
    if (isSeparateRuneSeries(card)) return "Runes";
    if (isToken(card)) return "Tokens";
    if (isSpecial(card)) return "Special / extras";
    return "Main set + alternate art";
  }

  function sectionRank(card, binderId = activeBinderId) {
    if (binderId === "PROMOS") return ({ PR: 0, OPP: 1, JDG: 2 })[card.setId] ?? 9;
    if (binderId === "OGN" && card.setId === "OGS") return 5;
    if (isSignature(card) || isOvernumbered(card)) return 4;
    if (isSeparateRuneSeries(card)) return 1;
    if (isToken(card)) return 2;
    if (isSpecial(card)) return 3;
    return 0;
  }

  function compareCards(a, b) {
    const rankDifference = sectionRank(a) - sectionRank(b);
    if (rankDifference) return rankDifference;
    if (a.number !== b.number) return Number(a.number) - Number(b.number);
    if (isAlternate(a) !== isAlternate(b)) return isAlternate(a) ? 1 : -1;
    if (isSignature(a) !== isSignature(b)) return isSignature(a) ? 1 : -1;
    return String(a.tcgplayerId || a.code || a.id).localeCompare(String(b.tcgplayerId || b.code || b.id), undefined, { numeric: true });
  }

  function currentBinderDefinition() {
    return BINDER_DEFINITIONS.find(binder => binder.id === activeBinderId) || BINDER_DEFINITIONS.find(binder => binder.id === "SFD");
  }

  function binderForCard(card) {
    return BINDER_DEFINITIONS.find(binder => binder.sources.includes(card.setId)) || BINDER_DEFINITIONS.find(binder => binder.id === "SFD");
  }

  function isMobileView() {
    return mobileMedia.matches;
  }

  function currentBinderState() {
    return database.binders[activeBinderId];
  }

  function buildBinderCards() {
    const definition = currentBinderDefinition();
    currentCards = catalog.cards
      .filter(card => definition.sources.includes(card.setId))
      .map(card => ({ ...card, _key: cardKey(card), _section: sectionFor(card) }))
      .sort(compareCards);
  }

  function pocketsPerPage() {
    return 4 * currentBinderDefinition().rows;
  }

  function locationFor(index) {
    const perPage = pocketsPerPage();
    const page = Math.floor(index / perPage) + 1;
    const slot = (index % perPage) + 1;
    return { index, page, slot, spread: Math.floor(page / 2) + 1, side: page % 2 === 0 ? "left" : "right" };
  }

  function maximumSpread() {
    const pages = Math.max(1, Math.ceil(currentCards.length / pocketsPerPage()));
    return Math.floor((pages + 1) / 2) + 1;
  }

  function getEntry(key) {
    const raw = currentBinderState().statuses[key];
    if (!raw) return { status: "missing", quantity: 0 };
    if (typeof raw === "string") return { status: raw, quantity: raw === "collected" ? 1 : 0 };
    return { status: raw.status || "missing", quantity: Number(raw.quantity || 0) };
  }

  function setStatus(key, status, { increment = false, quiet = false } = {}) {
    if (!key) return;
    const state = currentBinderState();
    const previous = state.statuses[key] ? structuredClone(state.statuses[key]) : null;
    undoStack.push({ binderId: activeBinderId, key, previous });
    if (status === "missing") {
      delete state.statuses[key];
    } else {
      const existing = getEntry(key);
      state.statuses[key] = {
        status,
        quantity: status === "collected" ? Math.max(1, existing.quantity + (increment ? 1 : 0)) : existing.quantity,
        updatedAt: new Date().toISOString()
      };
    }
    state.updatedAt = new Date().toISOString();
    saveDatabase();
    renderAll();
    if (!quiet) showToast(status === "missing" ? "Marked missing" : status === "ordered" ? "Marked ordered" : "Marked collected");
  }

  function renderPreview(card) {
    const entry = getEntry(card._key);
    const location = locationFor(currentCards.findIndex(candidate => candidate._key === card._key));
    elements.previewImage.src = card.image;
    elements.previewImage.alt = `${card.name} card`;
    elements.previewMeta.textContent = `${card.setId} · ${displayCode(card)} · Page ${location.page}, pocket ${location.slot}`;
    elements.previewName.textContent = card.name;
    elements.previewCollected.checked = entry.status === "collected";
    elements.previewStatus.textContent = entry.status === "ordered" ? "Currently marked ordered. Checking Collected will replace that status." : "Previewing never changes collection status.";
  }

  function openPreview(card) {
    selectedKey = card._key;
    renderSpread();
    renderDetail();
    renderPreview(card);
    elements.previewDialog.showModal();
  }

  function undo() {
    const change = undoStack.pop();
    if (!change) return;
    const previousBinderId = activeBinderId;
    activeBinderId = change.binderId;
    const state = currentBinderState();
    if (change.previous === null) delete state.statuses[change.key];
    else state.statuses[change.key] = change.previous;
    if (previousBinderId !== activeBinderId) {
      buildBinderCards();
      selectedKey = change.key;
    }
    saveDatabase("Undo saved");
    renderAll();
    showToast("Last change undone");
  }

  function displayCode(card) {
    const code = String(card.code || `${card.setId}-${card.number}`).toUpperCase();
    const withoutSet = code.replace(new RegExp(`^${card.setId}-`, "i"), "");
    return withoutSet.replace(/-(\d+)$/, "/$1");
  }

  function initializeBinderState() {
    buildBinderCards();
    const state = currentBinderState();
    if (!state.layout.length && currentCards.length) {
      state.layout = currentLayoutSnapshot();
      state.layoutSavedAt = new Date().toISOString();
      saveDatabase("Layout baseline saved");
    }
    if (!selectedKey || !currentCards.some(card => card._key === selectedKey)) selectedKey = currentCards[0]?._key || null;
  }

  function currentLayoutSnapshot() {
    return currentCards.map((card, index) => ({ key: card._key, ...locationFor(index) }));
  }

  function renderBinderSelect() {
    elements.binderSelect.replaceChildren(...BINDER_DEFINITIONS.map(binder => {
      const count = catalog.cards.filter(card => binder.sources.includes(card.setId)).length;
      const option = document.createElement("option");
      option.value = binder.id;
      option.textContent = `${binder.label} · ${count}`;
      option.selected = binder.id === activeBinderId;
      return option;
    }));
    const definition = currentBinderDefinition();
    const pages = Math.ceil(currentCards.length / pocketsPerPage());
    elements.binderMeta.textContent = `${definition.format} · ${pages} pocket pages · ${pocketsPerPage()} pockets/page`;
  }


  function marketPrice(card) {
    const table = window.RIFTBOUND_PRICES && window.RIFTBOUND_PRICES.byTcgplayerId;
    if (!table || card.tcgplayerId == null) return null;
    const value = table[String(card.tcgplayerId)];
    return typeof value === "number" ? value : null;
  }

  function formatUsd(value) {
    if (value == null) return "—";
    return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  }

  function renderStats() {
    let collected = 0;
    let ordered = 0;
    const bySection = new Map();
    currentCards.forEach((card, index) => {
      const entry = getEntry(card._key);
      if (entry.status === "collected") collected += 1;
      if (entry.status === "ordered") ordered += 1;
      const section = bySection.get(card._section) || { total: 0, collected: 0, firstIndex: index };
      section.total += 1;
      if (entry.status === "collected") section.collected += 1;
      bySection.set(card._section, section);
    });
    const total = currentCards.length;
    const percent = total ? collected / total * 100 : 0;
    elements.percentStat.textContent = `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
    elements.progressBar.style.width = `${percent}%`;
    elements.collectedStat.textContent = `${collected} of ${total} cards`;
    elements.missingStat.textContent = String(total - collected - ordered);
    elements.orderedStat.textContent = String(ordered);
    let portfolio = 0;
    let priced = 0;
    let unpriced = 0;
    currentCards.forEach(card => {
      const entry = getEntry(card._key);
      if (entry.status !== "collected") return;
      const price = marketPrice(card);
      if (price == null) {
        unpriced += 1;
        return;
      }
      priced += 1;
      portfolio += price * Math.max(1, entry.quantity || 1);
    });
    if (elements.portfolioStat) {
      elements.portfolioStat.textContent = formatUsd(priced || unpriced ? portfolio : null);
      elements.portfolioStat.title = unpriced
        ? `${priced} priced, ${unpriced} collected without a TCGplayer market price (excluded from the total)`
        : `${priced} collected cards with a market price`;
    }
    elements.sectionStats.replaceChildren(...[...bySection].map(([name, values]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "section-stat";
      button.title = `Jump to ${name}`;
      button.innerHTML = `${escapeHtml(shortSection(name))} <strong>${values.collected}/${values.total}</strong>`;
      button.addEventListener("click", () => goToIndex(values.firstIndex));
      return button;
    }));
  }

  function goToIndex(index) {
    const location = locationFor(index);
    currentSpread = location.spread;
    currentMobilePage = location.page;
    renderSpread();
  }

  function shortSection(name) {
    return name.replace("Main set + alternate art", "Main + alts").replace("Overnumbered + signatures", "Chase pairs").replace("Proving Grounds (OGS)", "Proving Grounds").replace("Organized Play", "OP");
  }

  function sectionAtPage(page) {
    if (!page) return "";
    const start = (page - 1) * pocketsPerPage();
    const sections = [...new Set(currentCards.slice(start, start + pocketsPerPage()).map(card => card._section))];
    return sections.map(shortSection).join(" · ");
  }

  function sectionRanges() {
    const ranges = [];
    currentCards.forEach((card, index) => {
      let range = ranges[ranges.length - 1];
      if (!range || range.name !== card._section) {
        range = { name: card._section, firstIndex: index, lastIndex: index, total: 0, collected: 0 };
        ranges.push(range);
      }
      range.lastIndex = index;
      range.total += 1;
      if (getEntry(card._key).status === "collected") range.collected += 1;
    });
    return ranges;
  }

  function renderInsideCover(container) {
    const definition = currentBinderDefinition();
    const ranges = sectionRanges();
    const collected = currentCards.filter(card => getEntry(card._key).status === "collected").length;
    container.className = "inside-overview";

    const hero = document.createElement("div");
    hero.className = "overview-hero";
    hero.innerHTML = `<span class="overview-emblem">${escapeHtml(definition.id === "PROMOS" ? "P" : definition.id.slice(0, 1))}</span><span><strong>${escapeHtml(definition.label)}</strong><span>${collected} of ${currentCards.length} collected · ${Math.ceil(currentCards.length / pocketsPerPage())} pocket pages</span></span>`;

    const sections = document.createElement("div");
    sections.className = "overview-sections";
    sections.replaceChildren(...ranges.map(range => {
      const start = locationFor(range.firstIndex);
      const end = locationFor(range.lastIndex);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "overview-section";
      button.innerHTML = `<span><strong>${escapeHtml(range.name)}</strong><span>${start.page === end.page ? `Page ${start.page}` : `Pages ${start.page}–${end.page}`} · ${range.total} cards</span></span><b>${range.collected}/${range.total} →</b>`;
      button.addEventListener("click", () => goToIndex(range.firstIndex));
      return button;
    }));

    const tip = document.createElement("p");
    tip.className = "overview-tip";
    tip.textContent = "This inside-cover map is digital only. It does not consume a physical pocket. Select a section to jump directly to its first card.";
    container.replaceChildren(hero, sections, tip);
  }

  function renderPage(container, page) {
    const rows = currentBinderDefinition().rows;
    container.className = `pocket-grid rows-${rows}`;
    const count = pocketsPerPage();
    const baseline = new Set(currentBinderState().layout.map(entry => entry.key));
    const pockets = [];
    for (let slot = 1; slot <= count; slot += 1) {
      const index = page ? (page - 1) * count + slot - 1 : -1;
      const card = index >= 0 ? currentCards[index] : null;
      if (!card) {
        const empty = document.createElement("div");
        empty.className = "pocket empty";
        empty.setAttribute("aria-hidden", "true");
        pockets.push(empty);
        continue;
      }
      const entry = getEntry(card._key);
      const pocket = document.createElement("div");
      pocket.className = `pocket ${entry.status}${card._key === selectedKey ? " active" : ""}`;
      pocket.dataset.key = card._key;
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "pocket-preview";
      preview.setAttribute("aria-label", `Preview ${card.name}, ${displayCode(card)}`);
      preview.title = `View ${card.name}`;
      const image = document.createElement("img");
      image.src = card.image;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => { image.hidden = true; pocket.classList.add("image-error"); }, { once: true });
      preview.appendChild(image);
      const overlay = document.createElement("span");
      overlay.className = "pocket-overlay";
      const price = marketPrice(card);
      overlay.innerHTML = `<span class="pocket-name">${escapeHtml(card.name)}</span><span class="pocket-code">${escapeHtml(displayCode(card))}${price != null ? ` · ${formatUsd(price)}` : ""}</span>`;
      preview.appendChild(overlay);
      preview.addEventListener("click", () => openPreview(card));
      pocket.appendChild(preview);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "collection-check";
      checkbox.checked = entry.status === "collected";
      checkbox.setAttribute("aria-label", `Mark ${card.name} as collected`);
      checkbox.title = entry.status === "collected" ? "Unmark collected" : "Mark collected";
      checkbox.addEventListener("change", () => {
        selectedKey = card._key;
        setStatus(card._key, checkbox.checked ? "collected" : "missing", { quiet: true });
        showToast(`${card.name} ${checkbox.checked ? "collected" : "uncollected"}`);
      });
      pocket.appendChild(checkbox);
      if (entry.status === "ordered") {
        const ordered = document.createElement("span");
        ordered.className = "ordered-mark";
        ordered.textContent = "◷";
        ordered.setAttribute("aria-label", "Ordered");
        pocket.appendChild(ordered);
      }
      if (!baseline.has(card._key)) {
        const flag = document.createElement("span");
        flag.className = "new-flag";
        flag.textContent = "NEW";
        pocket.appendChild(flag);
      }
      pockets.push(pocket);
    }
    container.replaceChildren(...pockets);
  }

  function renderSpread() {
    const totalPages = Math.max(1, Math.ceil(currentCards.length / pocketsPerPage()));
    elements.pageJump.max = totalPages;

    if (isMobileView()) {
      currentMobilePage = Math.max(1, Math.min(currentMobilePage, totalPages));
      renderPage(elements.leftGrid, currentMobilePage);
      renderPage(elements.rightGrid, null);
      elements.leftPageLabel.textContent = `Page ${currentMobilePage}`;
      elements.rightPageLabel.textContent = "";
      elements.leftSectionLabel.textContent = sectionAtPage(currentMobilePage);
      elements.rightSectionLabel.textContent = "";
      elements.spreadTitle.textContent = `Page ${currentMobilePage} of ${totalPages}`;
      elements.spreadSubtitle.textContent = sectionAtPage(currentMobilePage);
      elements.previousSpread.disabled = currentMobilePage === 1;
      elements.nextSpread.disabled = currentMobilePage === totalPages;
      elements.binderPrevious.disabled = currentMobilePage === 1;
      elements.binderNext.disabled = currentMobilePage === totalPages;
      elements.pageJump.value = currentMobilePage;
    } else {
      currentSpread = Math.max(1, Math.min(currentSpread, maximumSpread()));
      const leftPage = currentSpread === 1 ? null : (currentSpread - 1) * 2;
      const rightPage = currentSpread === 1 ? 1 : leftPage + 1;
      if (leftPage) renderPage(elements.leftGrid, leftPage <= totalPages ? leftPage : null);
      else renderInsideCover(elements.leftGrid);
      renderPage(elements.rightGrid, rightPage <= totalPages ? rightPage : null);
      elements.leftPageLabel.textContent = leftPage ? `Page ${leftPage}` : "Binder overview";
      elements.rightPageLabel.textContent = rightPage <= totalPages ? `Page ${rightPage}` : "Inside back cover";
      elements.leftSectionLabel.textContent = sectionAtPage(leftPage);
      elements.rightSectionLabel.textContent = rightPage <= totalPages ? sectionAtPage(rightPage) : "";
      elements.spreadTitle.textContent = `Spread ${currentSpread} of ${maximumSpread()}`;
      elements.spreadSubtitle.textContent = leftPage ? `Pages ${leftPage}–${Math.min(rightPage, totalPages)}` : "Overview + page 1";
      elements.previousSpread.disabled = currentSpread === 1;
      elements.nextSpread.disabled = currentSpread === maximumSpread();
      elements.binderPrevious.disabled = currentSpread === 1;
      elements.binderNext.disabled = currentSpread === maximumSpread();
      elements.pageJump.value = rightPage <= totalPages ? rightPage : totalPages;
    }
    renderSectionNavigation();
  }

  function renderSectionNavigation() {
    const starts = [];
    currentCards.forEach((card, index) => {
      if (!index || card._section !== currentCards[index - 1]._section) starts.push({ name: card._section, index });
    });
    const currentPage = isMobileView() ? currentMobilePage : currentSpread === 1 ? 1 : (currentSpread - 1) * 2;
    const currentIndex = Math.max(0, (currentPage - 1) * pocketsPerPage());
    const activeSection = currentCards[currentIndex]?._section;
    elements.sectionNav.replaceChildren(...starts.map(start => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `section-chip${start.name === activeSection ? " active" : ""}`;
      button.textContent = shortSection(start.name);
      button.addEventListener("click", () => goToIndex(start.index));
      return button;
    }));
  }

  function selectCard(key, navigate = false) {
    const index = currentCards.findIndex(card => card._key === key);
    if (index < 0) return;
    selectedKey = key;
    if (navigate) {
      currentSpread = locationFor(index).spread;
      currentMobilePage = locationFor(index).page;
    }
    renderSpread();
    renderDetail();
  }

  function renderDetail() {
    const index = currentCards.findIndex(card => card._key === selectedKey);
    const card = currentCards[index];
    [elements.markCollected, elements.markOrdered, elements.markMissing].forEach(button => button.disabled = !card);
    elements.undoButton.disabled = !undoStack.length;
    if (!card) return;
    const entry = getEntry(card._key);
    const location = locationFor(index);
    elements.detailImage.src = card.image;
    elements.detailImage.alt = card.name;
    elements.detailImage.hidden = false;
    elements.detailFallback.hidden = true;
    elements.detailImage.onerror = () => { elements.detailImage.hidden = true; elements.detailFallback.hidden = false; elements.detailFallback.textContent = "Preview unavailable"; };
    elements.detailId.textContent = `${card.setId} · ${displayCode(card)}`;
    elements.detailSection.textContent = card._section;
    elements.detailName.textContent = card.name;
    elements.detailLocation.textContent = `Page ${location.page}, pocket ${location.slot} · ${entry.status}${entry.quantity > 1 ? ` · ${entry.quantity} copies` : ""}${card.rarity ? ` · ${card.rarity}` : ""}${card.synthetic ? " · confirmed printing; preview uses the matching overnumber art until its signature scan is published" : ""}`;
    elements.markCollected.classList.toggle("selected", entry.status === "collected");
    elements.markOrdered.classList.toggle("selected", entry.status === "ordered");
    elements.markMissing.classList.toggle("selected", entry.status === "missing");
    elements.markCollected.setAttribute("aria-pressed", String(entry.status === "collected"));
    elements.markOrdered.setAttribute("aria-pressed", String(entry.status === "ordered"));
    elements.markMissing.setAttribute("aria-pressed", String(entry.status === "missing"));
  }

  function renderAll() {
    renderBinderSelect();
    renderStats();
    renderSpread();
    renderDetail();
    elements.undoButton.disabled = !undoStack.length;
    elements.binderStage.classList.toggle("missing-only-mode", elements.missingOnly.checked);
    elements.binderStage.classList.toggle("promo-binder", activeBinderId === "PROMOS");
    elements.binderStage.classList.toggle("mobile-single", isMobileView());
    renderCatalogStatus();
  }

  function cardSearch(query, limit = 8, scope = "current") {
    const normalized = normalize(query);
    if (!normalized) return [];
    const pool = scope === "global"
      ? catalog.cards.map(card => {
          const binder = binderForCard(card);
          return { ...card, _key: cardKey(card), _section: sectionFor(card, binder.id), _binderId: binder.id };
        })
      : currentCards.map(card => ({ ...card, _binderId: activeBinderId }));
    return pool
      .map((card, index) => {
        const code = normalize(displayCode(card));
        const name = normalize(card.name);
        const numericQuery = /^\d+$/.test(normalized) ? Number(normalized) : null;
        let score = 99;
        if (numericQuery !== null && Number(card.number) === numericQuery) score = 0;
        else if (code === normalized || normalize(card.code) === normalized) score = 0;
        else if (name === normalized) score = 1;
        else if (name.startsWith(normalized)) score = 2;
        else if (code.startsWith(normalized)) score = 3;
        else if (name.includes(normalized)) score = 4;
        else if (normalize(card.code).includes(normalized)) score = 5;
        return { card, index, score };
      })
      .filter(result => result.score < 99)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .slice(0, limit);
  }

  function activeSearchScope() {
    return elements.searchScopeAll.checked ? "global" : "current";
  }

  function renderSearchResults() {
    const scope = activeSearchScope();
    const results = cardSearch(elements.searchInput.value, 10, scope);
    if (!results.length) {
      if (!elements.searchInput.value.trim()) {
        elements.searchResults.hidden = true;
        return;
      }
      const empty = document.createElement("div");
      empty.className = "no-results";
      empty.textContent = scope === "global" ? "No card matches across your binders." : `No card matches in ${currentBinderDefinition().label}.`;
      elements.searchResults.replaceChildren(empty);
      elements.searchResults.hidden = false;
      return;
    }
    elements.searchResults.replaceChildren(...results.map(({ card }) => {
      const binder = BINDER_DEFINITIONS.find(candidate => candidate.id === card._binderId);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result";
      button.dataset.binderId = card._binderId;
      button.innerHTML = `<strong>${escapeHtml(card.name)}</strong><span>${escapeHtml(card.setId)} · ${escapeHtml(displayCode(card))}${scope === "global" ? ` · ${escapeHtml(binder.label)}` : ` · ${escapeHtml(card._section)}`}</span>`;
      button.addEventListener("click", () => {
        elements.searchInput.value = "";
        elements.searchResults.hidden = true;
        navigateToSearchResult(card);
      });
      return button;
    }));
    elements.searchResults.hidden = false;
  }

  function navigateToSearchResult(card) {
    if (card._binderId !== activeBinderId) {
      activeBinderId = card._binderId;
      currentSpread = 1;
      currentMobilePage = 1;
      selectedKey = null;
      initializeBinderState();
      renderAll();
    }
    selectCard(card._key, true);
  }

  function renderPackMatches() {
    const results = cardSearch(elements.packInput.value, 6);
    elements.packMatches.replaceChildren(...results.map(({ card }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pack-match";
      const quantity = getEntry(card._key).quantity;
      button.innerHTML = `<img src="${escapeAttribute(card.image)}" alt=""><span><strong>${escapeHtml(card.name)}</strong><span>${escapeHtml(displayCode(card))} · ${escapeHtml(card._section)}</span></span><span class="quantity">×${quantity}</span>`;
      button.addEventListener("click", () => addPackCard(card));
      return button;
    }));
  }

  function addPackCard(card) {
    selectedKey = card._key;
    setStatus(card._key, "collected", { increment: true, quiet: true });
    packRecent.unshift({ key: card._key, addedAt: new Date() });
    packRecent = packRecent.slice(0, 12);
    elements.packInput.value = "";
    renderPackMatches();
    renderPackRecent();
    elements.packInput.focus();
    showToast(`${card.name} added`);
  }

  function renderPackRecent() {
    elements.packRecent.replaceChildren(...packRecent.map(item => {
      const card = currentCards.find(candidate => candidate._key === item.key);
      if (!card) return document.createTextNode("");
      const row = document.createElement("div");
      row.className = "recent-item";
      row.innerHTML = `<img src="${escapeAttribute(card.image)}" alt=""><span><strong>${escapeHtml(card.name)}</strong><span>${escapeHtml(displayCode(card))} · just added</span></span><span class="quantity">×${getEntry(card._key).quantity}</span>`;
      return row;
    }));
  }

  function buildLayoutChanges() {
    const baseline = new Map(currentBinderState().layout.map(entry => [entry.key, entry]));
    const changes = [];
    currentCards.forEach((card, index) => {
      const to = locationFor(index);
      const from = baseline.get(card._key);
      if (!from) changes.push({ type: "add", card, to });
      else if (from.page !== to.page || from.slot !== to.slot) changes.push({ type: "shift", card, from, to });
    });
    return changes.sort((a, b) => b.to.index - a.to.index);
  }

  function openLayoutDialog() {
    const changes = buildLayoutChanges();
    const added = changes.filter(change => change.type === "add").length;
    const shifted = changes.length - added;
    elements.layoutSummary.textContent = changes.length
      ? `${added} new pockets and ${shifted} shifted cards. Work from the highest page downward so cards never overwrite a destination you still need.`
      : "Your saved physical layout matches the current catalog. No moves are needed.";
    elements.acceptLayout.disabled = !changes.length;
    elements.downloadLayout.disabled = !changes.length;
    elements.layoutChanges.replaceChildren(...changes.map(change => {
      const row = document.createElement("div");
      row.className = `change-item ${change.type}`;
      row.innerHTML = change.type === "add"
        ? `<span class="change-number">NEW</span><span><strong>${escapeHtml(change.card.name)} · ${escapeHtml(displayCode(change.card))}</strong><br><span>Reserve/place at page ${change.to.page}, pocket ${change.to.slot}.</span></span>`
        : `<span class="change-number">MOVE</span><span><strong>${escapeHtml(change.card.name)} · ${escapeHtml(displayCode(change.card))}</strong><br><span>Page ${change.from.page}, pocket ${change.from.slot} → page ${change.to.page}, pocket ${change.to.slot}.</span></span>`;
      return row;
    }));
    elements.layoutDialog.showModal();
  }

  function acceptCurrentLayout() {
    currentBinderState().layout = currentLayoutSnapshot();
    currentBinderState().layoutSavedAt = new Date().toISOString();
    saveDatabase("Layout baseline updated");
    elements.layoutDialog.close();
    renderAll();
    showToast("Physical layout baseline updated");
  }

  function downloadLayoutPlan() {
    const changes = buildLayoutChanges();
    const lines = [`${currentBinderDefinition().label} binder update plan`, "Work from the bottom/highest page upward.", ""];
    changes.forEach(change => {
      if (change.type === "add") lines.push(`ADD ${displayCode(change.card)} ${change.card.name}: page ${change.to.page}, pocket ${change.to.slot}`);
      else lines.push(`MOVE ${displayCode(change.card)} ${change.card.name}: page ${change.from.page}, pocket ${change.from.slot} -> page ${change.to.page}, pocket ${change.to.slot}`);
    });
    downloadText(`${activeBinderId.toLowerCase()}-binder-update.txt`, lines.join("\n"), "text/plain");
  }

  function exportShoppingList() {
    const rows = [["Binder", "Set", "Printed ID", "Card", "Section", "Status", "TCGplayer URL"]];
    currentCards.forEach(card => {
      const entry = getEntry(card._key);
      if (entry.status === "collected") return;
      rows.push([
        currentBinderDefinition().label, card.setId, displayCode(card), card.name, card._section, entry.status,
        card.tcgplayerId ? `https://www.tcgplayer.com/product/${card.tcgplayerId}` : ""
      ]);
    });
    const csv = rows.map(row => row.map(csvCell).join(",")).join("\n");
    downloadText(`${activeBinderId.toLowerCase()}-shopping-list.csv`, csv, "text/csv");
    showToast(`${rows.length - 1} cards exported`);
  }

  function exportBackup() {
    saveDatabase();
    const payload = { app: "Riftbound Binder Atlas", appVersion: APP_VERSION, exportedAt: new Date().toISOString(), database };
    downloadText(`riftbound-binder-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), "application/json");
    showToast("Backup exported");
  }

  async function importBackup(file) {
    const parsed = JSON.parse(await file.text());
    const incoming = parsed.database || parsed;
    if (!incoming || (!incoming.binders && !incoming.sets)) throw new Error("Collection data missing");
    database = incoming.schemaVersion >= 2 ? upgradeDatabase(incoming) : migrateVersionOne(incoming);
    activeBinderId = database.preferences?.activeBinder || "SFD";
    undoStack = [];
    initializeBinderState();
    saveDatabase("Imported backup saved");
    renderAll();
    showToast("Backup imported");
  }

  function renderCatalogStatus() {
    const generated = catalog.generatedAt ? new Date(catalog.generatedAt).toLocaleString() : "unknown";
    const tcgLinked = catalog.cards.filter(card => card.tcgplayerId).length;
    elements.catalogStatus.textContent = `${catalog.cards.length.toLocaleString()} cards across ${catalog.sets.length} source sets. Snapshot: ${generated}. ${tcgLinked.toLocaleString()} cards cross-linked to TCGplayer.`;
  }

  async function syncCatalog() {
    elements.syncButton.disabled = true;
    elements.syncButton.textContent = "Connecting…";
    try {
      const setPayload = await fetchJson(`${API}/sets?size=100`);
      const sets = setPayload.items;
      let finished = 0;
      const cardGroups = await promisePool(sets, 3, async set => {
        const cards = await fetchAllSetCards(set.set_id);
        finished += 1;
        elements.syncButton.textContent = `Syncing ${finished}/${sets.length} sets…`;
        return cards;
      });
      const next = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        source: `${API} (Riftcodex, unofficial)`,
        sets: sets.map(set => ({ id: set.set_id, name: set.name, cardCount: set.card_count, publishedOn: set.published_on, tcgplayerGroupId: set.tcgplayer_id || null })),
        cards: cardGroups.flat().map(compactApiCard)
      };
      sets.forEach(set => {
        const actual = next.cards.filter(card => card.setId === set.set_id).length;
        if (actual !== set.card_count) throw new Error(`${set.set_id}: expected ${set.card_count}, received ${actual}`);
      });
      try { localStorage.setItem(CATALOG_KEY, JSON.stringify(next)); } catch { showToast("Catalog updated for this session; browser cache is full"); }
      catalog = sanitizeCatalog(next);
      localStorage.setItem(CHECK_KEY, new Date().toISOString());
      elements.updateBanner.hidden = true;
      initializeBinderState();
      renderAll();
      showToast(`Catalog synced: ${catalog.cards.length} cards`);
    } catch (error) {
      console.error(error);
      showToast(`Sync failed: ${error.message}`);
    } finally {
      elements.syncButton.disabled = false;
      elements.syncButton.textContent = "Check & sync card lists";
    }
  }

  async function fetchAllSetCards(setId) {
    const first = await fetchJson(`${API}/cards?size=100&page=1&set_id=${encodeURIComponent(setId)}&sort=collector_number`);
    const pageNumbers = Array.from({ length: Math.max(0, first.pages - 1) }, (_, index) => index + 2);
    const rest = await promisePool(pageNumbers, 4, page => fetchJson(`${API}/cards?size=100&page=${page}&set_id=${encodeURIComponent(setId)}&sort=collector_number`));
    return [first, ...rest].flatMap(page => page.items);
  }

  async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  function compactApiCard(card) {
    return {
      id: card.id, code: card.riftbound_id, tcgplayerId: card.tcgplayer_id || null,
      number: card.collector_number, name: card.name, setId: card.set.set_id, setName: card.set.label,
      type: card.classification.type, supertype: card.classification.supertype || null,
      rarity: card.classification.rarity, domains: card.classification.domain || [],
      image: card.media.image_url, artist: card.media.artist || null,
      alt: Boolean(card.metadata.alternate_art), overnumbered: Boolean(card.metadata.overnumbered),
      signature: Boolean(card.metadata.signature), updatedOn: card.metadata.updated_on || null, isNew: Boolean(card.new)
    };
  }

  async function checkForCatalogUpdates() {
    const last = new Date(localStorage.getItem(CHECK_KEY) || 0);
    if (Date.now() - last.getTime() < 24 * 60 * 60 * 1000) return;
    try {
      const payload = await fetchJson(`${API}/sets?size=100`);
      localStorage.setItem(CHECK_KEY, new Date().toISOString());
      const localCounts = new Map(catalog.sets.map(set => [set.id, set.cardCount]));
      const changed = payload.items.filter(set => localCounts.get(set.set_id) !== set.card_count);
      if (!changed.length) return;
      elements.updateBanner.hidden = false;
      elements.updateBanner.innerHTML = `<strong>Card-list update available</strong><br>${changed.map(set => `${escapeHtml(set.set_id)}: ${localCounts.get(set.set_id) || 0} → ${set.card_count}`).join(" · ")}<br><button id="bannerSync" class="primary">Sync now</button>`;
      $("bannerSync").addEventListener("click", syncCatalog);
    } catch {
      // Offline use is intentional; the bundled snapshot remains available.
    }
  }

  async function promisePool(items, concurrency, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function run() {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
    return results;
  }

  function downloadText(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function csvCell(value) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replaceAll("'", "&#39;");
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
  }

  elements.binderSelect.addEventListener("change", event => {
    activeBinderId = event.target.value;
    currentSpread = 1;
    currentMobilePage = 1;
    selectedKey = null;
    initializeBinderState();
    renderAll();
  });
  function turnPage(direction) {
    if (isMobileView()) currentMobilePage += direction;
    else currentSpread += direction;
    renderSpread();
  }
  elements.previousSpread.addEventListener("click", () => turnPage(-1));
  elements.nextSpread.addEventListener("click", () => turnPage(1));
  elements.binderPrevious.addEventListener("click", () => turnPage(-1));
  elements.binderNext.addEventListener("click", () => turnPage(1));
  elements.pageJump.addEventListener("change", event => {
    const page = Math.max(1, Math.min(Number(event.target.value), Number(event.target.max)));
    currentSpread = Math.floor(page / 2) + 1;
    currentMobilePage = page;
    renderSpread();
  });
  elements.missingOnly.addEventListener("change", () => { saveDatabase(); renderAll(); });
  elements.markCollected.addEventListener("click", () => setStatus(selectedKey, "collected"));
  elements.markOrdered.addEventListener("click", () => setStatus(selectedKey, "ordered"));
  elements.markMissing.addEventListener("click", () => setStatus(selectedKey, "missing"));
  elements.undoButton.addEventListener("click", undo);
  elements.previewCollected.addEventListener("change", () => {
    const card = currentCards.find(candidate => candidate._key === selectedKey);
    if (!card) return;
    const checked = elements.previewCollected.checked;
    setStatus(card._key, checked ? "collected" : "missing", { quiet: true });
    renderPreview(card);
    showToast(`${card.name} ${checked ? "collected" : "uncollected"}`);
  });
  elements.searchInput.addEventListener("input", renderSearchResults);
  elements.searchInput.addEventListener("focus", renderSearchResults);
  [elements.searchScopeCurrent, elements.searchScopeAll].forEach(control => control.addEventListener("change", renderSearchResults));
  elements.searchForm.addEventListener("submit", event => {
    event.preventDefault();
    const scope = activeSearchScope();
    const first = cardSearch(elements.searchInput.value, 1, scope)[0];
    if (!first) return showToast(scope === "global" ? "No matching card across your binders" : `No matching card in ${currentBinderDefinition().label}`);
    elements.searchInput.value = "";
    elements.searchResults.hidden = true;
    navigateToSearchResult(first.card);
  });
  document.addEventListener("click", event => {
    if (!elements.searchForm.contains(event.target)) elements.searchResults.hidden = true;
  });
  elements.packModeButton.addEventListener("click", () => {
    packRecent = [];
    elements.packInput.value = "";
    renderPackMatches();
    renderPackRecent();
    elements.packDialog.showModal();
    setTimeout(() => elements.packInput.focus(), 0);
  });
  elements.packInput.addEventListener("input", renderPackMatches);
  elements.packInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const first = cardSearch(elements.packInput.value, 1)[0];
    if (first) addPackCard(first.card);
    else showToast("No matching card in this binder");
  });
  elements.shoppingButton.addEventListener("click", exportShoppingList);
  elements.layoutButton.addEventListener("click", openLayoutDialog);
  elements.acceptLayout.addEventListener("click", acceptCurrentLayout);
  elements.downloadLayout.addEventListener("click", downloadLayoutPlan);
  elements.moreButton.addEventListener("click", () => elements.dataDialog.showModal());
  elements.syncButton.addEventListener("click", syncCatalog);
  elements.exportButton.addEventListener("click", exportBackup);
  elements.importInput.addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { await importBackup(file); }
    catch (error) { console.error(error); showToast("That backup file could not be imported"); }
    event.target.value = "";
  });
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
  document.addEventListener("keydown", event => {
    if (document.querySelector("dialog[open]")) return;
    const editing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if (!editing && event.key === "/") {
      event.preventDefault();
      elements.searchInput.focus();
      return;
    }
    if (editing) return;
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "z") { event.preventDefault(); undo(); return; }
    if (key === "c") { setStatus(selectedKey, "collected"); return; }
    if (key === "o") { setStatus(selectedKey, "ordered"); return; }
    if (key === "m") { setStatus(selectedKey, "missing"); return; }
    if (event.key === "ArrowLeft") turnPage(-1);
    if (event.key === "ArrowRight") turnPage(1);
  });
  mobileMedia.addEventListener("change", () => {
    const selectedIndex = currentCards.findIndex(card => card._key === selectedKey);
    if (selectedIndex >= 0) {
      const location = locationFor(selectedIndex);
      currentSpread = location.spread;
      currentMobilePage = location.page;
    }
    renderAll();
  });

  async function startApp() {
    try {
      const ok = await syncHostedCollection();
      if (!ok) return;
    } catch (error) {
      console.error(error);
      showToast("Could not reach your account; using this browser's copy");
    }
    elements.missingOnly.checked = Boolean(database.preferences?.missingOnly);
    initializeBinderState();
    saveDatabase(database.migratedFrom ? "Previous Spiritforged progress migrated" : (isProductionHost() ? "Saved" : "Saved locally"));
    renderAll();
    checkForCatalogUpdates();
  }
  startApp();
})();
