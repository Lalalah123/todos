(() => {
  const STORAGE_KEY = "todos-local-v2";
  const LEGACY_KEY = "todos-local-v1";
  const LINE_RE = /^\s*(?:-\s*)?\[([ xX])\]\s*(.*)$/;

  /** @typedef {{ id: string, text: string, done: boolean }} Todo */
  /** @typedef {{ id: string, text: string, date: string }} Archived */

  const cfg = window.APP_CONFIG || {};
  const STATE_ID = cfg.stateId || "main";

  const els = {
    todosSection: document.getElementById("todos-section"),
    archiveSection: document.getElementById("archive-section"),
    archiveRoot: document.getElementById("archive-root"),
    taskView: document.getElementById("task-view"),
    editView: document.getElementById("edit-view"),
    list: document.getElementById("todo-list"),
    addForm: document.getElementById("add-form"),
    addInput: document.getElementById("add-input"),
    editArea: document.getElementById("edit-area"),
    btnArchive: document.getElementById("btn-archive"),
    syncStatus: document.getElementById("sync-status"),
    btnSync: document.getElementById("btn-sync"),
    tabBtns: document.querySelectorAll(".tab-btn"),
    modeBtns: document.querySelectorAll(".mode-btn"),
  };

  const cloudConfigured = Boolean(cfg.supabaseUrl && cfg.supabaseKey);

  /** @type {{ tab: "todos" | "archive", mode: "task" | "edit", todos: Todo[], archives: Archived[] }} */
  let state =
    loadLocal() ||
    (cloudConfigured
      ? { tab: "todos", mode: "task", todos: [], archives: [] }
      : defaultState());
  let cloudReady = false;
  let initialPullDone = !cloudConfigured;
  let syncTimer = 0;
  let pollTimer = 0;
  let applyingRemote = false;
  let pushing = false;
  /** @type {string | null} */
  let lastRemoteUpdatedAt = null;

  function rowIsEmpty(row) {
    return (
      !row ||
      ((!row.todos || row.todos.length === 0) &&
        (!row.archives || row.archives.length === 0))
    );
  }

  function restHeaders(extra) {
    return Object.assign(
      {
        apikey: cfg.supabaseKey,
        Authorization: `Bearer ${cfg.supabaseKey}`,
        Accept: "application/json",
      },
      extra || {}
    );
  }

  function restUrl(pathQuery) {
    return `${cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1/${pathQuery}`;
  }

  /**
   * @returns {Promise<{ data: any, error: string | null }>}
   */
  async function restFetch(pathQuery, options) {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(restUrl(pathQuery), {
        ...options,
        signal: ctrl.signal,
        headers: restHeaders(options && options.headers),
      });
      const text = await res.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (!res.ok) {
        const msg =
          (body && body.message) ||
          (body && body.error) ||
          text ||
          `HTTP ${res.status}`;
        return { data: null, error: String(msg) };
      }
      return { data: body, error: null };
    } catch (err) {
      const msg =
        err && err.name === "AbortError"
          ? "连接超时"
          : (err && err.message) || "网络异常";
      return { data: null, error: msg };
    } finally {
      window.clearTimeout(timer);
    }
  }

  function uid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : `t-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function defaultState() {
    return {
      tab: "todos",
      mode: "task",
      todos: [
        { id: uid(), text: "打开这个页面", done: true },
        { id: uid(), text: "在任务模式勾选或改文案", done: false },
        { id: uid(), text: "切到编辑模式，整页改成 - [ ] / - [x]", done: false },
        { id: uid(), text: "点「归档已完成」把勾选过的按日期收进归档", done: false },
      ],
      archives: [],
    };
  }

  function normalizeTodos(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((t) => t && typeof t.text === "string")
      .map((t) => ({
        id: typeof t.id === "string" ? t.id : uid(),
        text: t.text,
        done: Boolean(t.done),
      }));
  }

  function normalizeArchives(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((a) => a && typeof a.text === "string" && typeof a.date === "string")
      .map((a) => ({
        id: typeof a.id === "string" ? a.id : uid(),
        text: a.text,
        date: a.date,
      }));
  }

  function normalizeState(data) {
    if (!data || !Array.isArray(data.todos)) return null;
    return {
      tab: data.tab === "archive" ? "archive" : "todos",
      mode: data.mode === "edit" ? "edit" : "task",
      todos: normalizeTodos(data.todos),
      archives: normalizeArchives(data.archives),
    };
  }

  function loadLocal() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      let fromLegacy = false;
      if (!raw) {
        raw = localStorage.getItem(LEGACY_KEY);
        fromLegacy = Boolean(raw);
      }
      if (!raw) return null;
      const data = JSON.parse(raw);
      const next = normalizeState(data);
      if (!next) return null;
      if (fromLegacy) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    } catch {
      return null;
    }
  }

  function saveLocal() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tab: state.tab,
        mode: state.mode,
        todos: state.todos,
        archives: state.archives,
      })
    );
  }

  function setSyncStatus(text, kind) {
    if (!els.syncStatus) return;
    els.syncStatus.textContent = text;
    els.syncStatus.dataset.kind = kind || "";
  }

  function payloadFromState() {
    return {
      id: STATE_ID,
      todos: state.todos,
      archives: state.archives,
      tab: state.tab,
      mode: state.mode,
      updated_at: new Date().toISOString(),
    };
  }

  function applyRemoteRow(row) {
    const next = normalizeState(row);
    if (!next) return false;
    applyingRemote = true;
    state = next;
    lastRemoteUpdatedAt = row.updated_at || null;
    saveLocal();
    render();
    applyingRemote = false;
    return true;
  }

  async function pushCloud() {
    if (!cloudReady || !initialPullDone || applyingRemote || pushing) return;
    pushing = true;
    setSyncStatus("同步中…", "pending");
    const payload = payloadFromState();
    const { data, error } = await restFetch(
      "todo_state?on_conflict=id&select=updated_at",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(payload),
      }
    );
    pushing = false;

    if (error) {
      console.error(error);
      setSyncStatus(`上传失败：${error}`, "error");
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    lastRemoteUpdatedAt = (row && row.updated_at) || payload.updated_at;
    setSyncStatus("已同步云端", "ok");
  }

  function scheduleCloudSave() {
    if (!cloudReady || !initialPullDone || applyingRemote) return;
    window.clearTimeout(syncTimer);
    setSyncStatus("待同步…", "pending");
    syncTimer = window.setTimeout(() => {
      pushCloud();
    }, 400);
  }

  function save() {
    saveLocal();
    scheduleCloudSave();
  }

  /**
   * @param {{ quiet?: boolean }} [opts]
   */
  async function pullCloud(opts = {}) {
    if (!cloudConfigured) return;
    const quiet = Boolean(opts.quiet);
    if (!quiet) setSyncStatus("连接云端…", "pending");

    const { data, error } = await restFetch(
      `todo_state?id=eq.${encodeURIComponent(STATE_ID)}&select=todos,archives,tab,mode,updated_at`,
      { method: "GET" }
    );

    if (error) {
      console.error(error);
      cloudReady = false;
      initialPullDone = true;
      setSyncStatus(`连不上云端：${error}`, "error");
      return;
    }

    cloudReady = true;
    const row = Array.isArray(data) ? data[0] : data;

    if (row && !rowIsEmpty(row)) {
      if (row.updated_at !== lastRemoteUpdatedAt) {
        applyRemoteRow(row);
        setSyncStatus(quiet ? "已从云端更新" : "已同步云端", "ok");
      } else if (!quiet) {
        setSyncStatus("已同步云端", "ok");
      }
    } else if (!rowIsEmpty(state)) {
      initialPullDone = true;
      await pushCloud();
    } else {
      if (row) applyRemoteRow(row);
      if (!quiet) setSyncStatus("已同步云端（空）", "ok");
    }

    initialPullDone = true;
  }

  function startPolling() {
    window.clearInterval(pollTimer);
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        pullCloud({ quiet: true });
      }
    }, 8000);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        pullCloud({ quiet: true });
      }
    });
    window.addEventListener("focus", () => {
      pullCloud({ quiet: true });
    });
  }

  async function initCloud() {
    if (!cloudConfigured) {
      setSyncStatus("仅本机存储", "");
      initialPullDone = true;
      return;
    }
    try {
      await pullCloud();
      startPolling();
    } catch (err) {
      console.error(err);
      initialPullDone = true;
      setSyncStatus("云端连接失败（本机仍可用）", "error");
    }
  }

  /** @param {Todo[]} todos */
  function serialize(todos) {
    return todos.map((t) => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n");
  }

  /**
   * @param {string} text
   * @param {Todo[]} previous
   */
  function parse(text, previous) {
    const lines = text.split(/\r?\n/);
    /** @type {Todo[]} */
    const next = [];
    let prevIndex = 0;

    for (const line of lines) {
      if (!line.trim()) continue;

      const m = line.match(LINE_RE);
      let done = false;
      let body = line.trim();

      if (m) {
        done = m[1].toLowerCase() === "x";
        body = m[2] ?? "";
      } else if (/^\s*-\s+/.test(line)) {
        body = line.replace(/^\s*-\s+/, "");
      }

      const prev = previous[prevIndex];
      next.push({
        id: prev ? prev.id : uid(),
        text: body,
        done,
      });
      prevIndex += 1;
    }

    return next;
  }

  function flushEditIfNeeded() {
    if (state.tab === "todos" && state.mode === "edit") {
      state.todos = parse(els.editArea.value, state.todos);
    }
  }

  function setTab(tab) {
    if (tab === state.tab) return;
    flushEditIfNeeded();
    state.tab = tab;
    save();
    render();
  }

  function setMode(mode) {
    if (mode === state.mode) return;
    flushEditIfNeeded();
    state.mode = mode;
    save();
    render();
  }

  function archiveDone() {
    flushEditIfNeeded();
    const done = state.todos.filter((t) => t.done);
    if (done.length === 0) return;

    const date = todayKey();
    const moved = done.map((t) => ({
      id: t.id,
      text: t.text,
      date,
    }));

    state.archives = [...moved, ...state.archives];
    state.todos = state.todos.filter((t) => !t.done);
    save();
    render();
  }

  function doneCount() {
    return state.todos.filter((t) => t.done).length;
  }

  /** @param {string} iso */
  function formatDateLabel(iso) {
    const parts = iso.split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return iso;
    const [y, m, d] = parts;
    const today = todayKey();
    const dt = new Date(y, m - 1, d);
    const week = ["日", "一", "二", "三", "四", "五", "六"][dt.getDay()];
    const base = `${y}年${m}月${d}日 · 周${week}`;
    return iso === today ? `${base}（今天）` : base;
  }

  function groupArchives() {
    /** @type {Map<string, Archived[]>} */
    const map = new Map();
    for (const item of state.archives) {
      if (!map.has(item.date)) map.set(item.date, []);
      map.get(item.date).push(item);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }

  function render() {
    const onArchive = state.tab === "archive";
    const isEdit = !onArchive && state.mode === "edit";

    els.tabBtns.forEach((btn) => {
      btn.setAttribute("aria-selected", String(btn.dataset.tab === state.tab));
    });

    els.modeBtns.forEach((btn) => {
      btn.setAttribute("aria-selected", String(btn.dataset.mode === state.mode));
    });

    els.todosSection.classList.toggle("hidden", onArchive);
    els.archiveSection.classList.toggle("hidden", !onArchive);
    els.archiveSection.hidden = !onArchive;

    const n = doneCount();
    els.btnArchive.disabled = n === 0;
    els.btnArchive.textContent =
      n > 0 ? `归档已完成（${n}）` : "归档已完成";

    if (onArchive) {
      renderArchive();
      return;
    }

    els.taskView.classList.toggle("hidden", isEdit);
    els.editView.classList.toggle("hidden", !isEdit);
    els.taskView.hidden = isEdit;
    els.editView.hidden = !isEdit;

    if (isEdit) {
      els.editArea.value = serialize(state.todos);
      return;
    }

    renderTaskList();
  }

  function renderTaskList() {
    els.list.replaceChildren();

    if (state.todos.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "还没有事项。在下方添加，或切到编辑模式整页粘贴。";
      els.list.append(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    state.todos.forEach((todo) => {
      frag.append(createTodoItem(todo));
    });
    els.list.append(frag);
  }

  /** @param {Todo} todo */
  function createTodoItem(todo) {
    const li = document.createElement("li");
    li.className = `todo-item${todo.done ? " is-done" : ""}`;
    li.dataset.id = todo.id;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "check";
    check.checked = todo.done;
    check.setAttribute("aria-label", "标记完成");
    check.addEventListener("change", () => {
      todo.done = check.checked;
      li.classList.toggle("is-done", todo.done);
      save();
      const n = doneCount();
      els.btnArchive.disabled = n === 0;
      els.btnArchive.textContent =
        n > 0 ? `归档已完成（${n}）` : "归档已完成";
    });

    const text = document.createElement("textarea");
    text.className = "todo-text";
    text.value = todo.text;
    text.rows = 1;
    text.setAttribute("aria-label", "事项内容");
    autoSize(text);
    text.addEventListener("input", () => {
      todo.text = text.value;
      autoSize(text);
      save();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-remove";
    remove.setAttribute("aria-label", "删除");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.todos = state.todos.filter((t) => t.id !== todo.id);
      save();
      render();
    });

    li.append(check, text, remove);
    return li;
  }

  function renderArchive() {
    els.archiveRoot.replaceChildren();
    const groups = groupArchives();

    if (groups.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "还没有归档。在待办里勾选完成后，点「归档已完成」。";
      els.archiveRoot.append(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const [date, items] of groups) {
      const day = document.createElement("section");
      day.className = "archive-day";

      const title = document.createElement("h2");
      title.className = "archive-day-title";
      title.append(document.createTextNode(formatDateLabel(date)));
      const count = document.createElement("span");
      count.textContent = `${items.length} 项`;
      title.append(count);

      const list = document.createElement("ul");
      list.className = "todo-list";
      items.forEach((item) => {
        list.append(createArchiveItem(item));
      });

      day.append(title, list);
      frag.append(day);
    }
    els.archiveRoot.append(frag);
  }

  /** @param {Archived} item */
  function createArchiveItem(item) {
    const li = document.createElement("li");
    li.className = "todo-item archive-item";
    li.dataset.id = item.id;

    const text = document.createElement("textarea");
    text.className = "todo-text";
    text.value = item.text;
    text.rows = 1;
    text.setAttribute("aria-label", "归档事项");
    autoSize(text);
    text.addEventListener("input", () => {
      item.text = text.value;
      autoSize(text);
      save();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-remove";
    remove.setAttribute("aria-label", "删除归档");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.archives = state.archives.filter((a) => a.id !== item.id);
      save();
      renderArchive();
    });

    li.append(text, remove);
    return li;
  }

  /** @param {HTMLTextAreaElement} el */
  function autoSize(el) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      setTab(btn.dataset.tab === "archive" ? "archive" : "todos");
    });
  });

  els.modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      setMode(btn.dataset.mode === "edit" ? "edit" : "task");
    });
  });

  els.btnArchive.addEventListener("click", archiveDone);

  if (els.btnSync) {
    els.btnSync.addEventListener("click", () => {
      pullCloud();
    });
  }

  els.addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.addInput.value.trim();
    if (!text) return;
    state.todos.push({ id: uid(), text, done: false });
    els.addInput.value = "";
    save();
    renderTaskList();
    const n = doneCount();
    els.btnArchive.disabled = n === 0;
    els.btnArchive.textContent =
      n > 0 ? `归档已完成（${n}）` : "归档已完成";
    els.addInput.focus();
  });

  let editSaveTimer = 0;
  els.editArea.addEventListener("input", () => {
    window.clearTimeout(editSaveTimer);
    editSaveTimer = window.setTimeout(() => {
      state.todos = parse(els.editArea.value, state.todos);
      save();
      const n = doneCount();
      els.btnArchive.disabled = n === 0;
      els.btnArchive.textContent =
        n > 0 ? `归档已完成（${n}）` : "归档已完成";
    }, 250);
  });

  window.addEventListener("beforeunload", () => {
    flushEditIfNeeded();
    saveLocal();
  });

  render();
  initCloud();
})();
