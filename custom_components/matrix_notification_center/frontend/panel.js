class MatrixNotificationCenterPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._state = null;
    this._tab = "active";
    this._draft = null;
    this._conditionQueries = {};
    this._ruleQuery = "";
    this._historyQuery = "";
    this._unsub = null;
    this._loading = false;
    this._validationErrors = new Set();
    this._testResult = null;
    this._testRecipient = "";
    this._settingsDraft = null;
    this._dragNodeId = null;
    this._renderQueued = false;
    this._draftTimer = null;
    this._draftStorageKey = "matrix_notification_center_rule_draft_1_2";
    this.shadowRoot.addEventListener("click", (event) => {
      if (!event.composedPath().some((item) => item?.classList?.contains?.("entity-search-wrap"))) {
        this.shadowRoot.querySelectorAll(".condition-results").forEach((box) => (box.innerHTML = ""));
      }
    });
  }

  set hass(value) {
    const first = !this._hass;
    this._hass = value;
    if (first) {
      this._subscribe();
      this._load();
    }
  }

  set panel(value) {
    this._panel = value;
  }

  set narrow(value) {
    this._narrow = value;
    this._queueRender();
  }

  set route(value) {
    this._route = value;
    const query = new URLSearchParams(window.location.search);
    const requestedTab = query.get("tab");
    if (requestedTab === "powiadomienia" || requestedTab === "active") {
      this._tab = "active";
    }
    if (this._state) this._queueRender();
  }

  connectedCallback() {
    this._queueRender();
  }

  disconnectedCallback() {
    if (this._unsub) this._unsub();
    clearTimeout(this._draftTimer);
  }

  async _subscribe() {
    try {
      this._unsub = await this._hass.connection.subscribeEvents(
        () => this._load(false),
        "matrix_notification_center_updated"
      );
    } catch (error) {
      console.warn("Matrix Notification Center event subscription failed", error);
    }
  }

  async _api(method, path, body) {
    return this._hass.callApi(method, `matrix_notification_center/${path}`, body);
  }

  async _load(spinner = true) {
    if (!this._hass) return;
    if (spinner) {
      this._loading = true;
      this._queueRender();
    }
    try {
      this._state = await this._api("GET", "state");
      const recipientNames = Object.keys(this._state?.settings?.recipients || {});
      if (!recipientNames.includes(this._testRecipient)) {
        this._testRecipient = recipientNames[0] || "";
      }
    } catch (error) {
      this._toast(`Błąd: ${error.message || error}`, true);
    }
    this._loading = false;
    this._queueRender();
  }

  _queueRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._render();
    });
  }

  _e(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  _time(value) {
    if (!value) return "brak";
    try {
      return new Intl.DateTimeFormat("pl-PL", {
        dateStyle: "short",
        timeStyle: "medium",
      }).format(new Date(value));
    } catch {
      return value;
    }
  }

  _meta(level) {
    return {
      krytyczne: ["🚨", "KRYTYCZNE", "critical"],
      ostrzezenie: ["⚠️", "OSTRZEŻENIE", "warning"],
      zadanie: ["✅", "ZADANIE", "task"],
      informacja: ["ℹ️", "INFORMACJA", "info"],
    }[level] || ["ℹ️", "INFORMACJA", "info"];
  }

  get _admin() {
    return Boolean(this._state?.is_admin || this._hass?.user?.is_admin);
  }

  _render() {
    if (!this.shadowRoot) return;
    if (!this._state) {
      this.shadowRoot.innerHTML = `
        <style>${this._css()}</style>
        <div class="boot"><div class="loader"></div><b>Ładowanie Centrum Powiadomień…</b></div>`;
      return;
    }

    const active = this._state.active || [];
    const critical = active.filter((item) => item.level === "krytyczne").length;
    const nav = [
      ["active", "🔔", "Powiadomienia"],
      ["history", "🕘", "Historia"],
    ];
    if (this._admin) {
      nav.push(
        ["rules", "🧠", "Reguły"],
        ["editor", "➕", "Kreator"],
        ["manual", "✉️", "Wyślij"],
        ["settings", "⚙️", "Ustawienia"],
        ["diag", "🩺", "Diagnostyka"]
      );
    }

    this.shadowRoot.innerHTML = `
      <style>${this._css()}</style>
      <div class="shell">
        <header class="top">
          <div class="brand">
            <div class="logo">M</div>
            <div><b>MATRIX NOTIFICATION CENTER</b><small>HOME ASSISTANT // SYSTEM ONLINE</small></div>
          </div>
          <div class="stats">
            <span>KRYTYCZNE <b class="${critical ? "red" : ""}">${critical}</b></span>
            <span>AKTYWNE <b>${active.length}</b></span>
            <span>REGUŁY <b>${this._state.diagnostics?.enabled_rules || 0}</b></span>
            <button data-act="refresh">↻</button>
          </div>
        </header>
        <nav>${nav
          .map(
            ([id, icon, text]) =>
              `<button class="${this._tab === id ? "on" : ""}" data-tab="${id}">${icon} ${text}</button>`
          )
          .join("")}</nav>
        <main>${this._body()}</main>
        ${this._loading ? `<div class="overlay"><div class="loader"></div></div>` : ""}
        <div id="toast" class="toast"></div>
      </div>`;

    this.shadowRoot.querySelectorAll("[data-tab]").forEach((button) => {
      button.onclick = () => {
        this._tab = button.dataset.tab;
        if (this._tab === "editor" && !this._draft) {
          this._draft = this._restoreDraft() || this._newDraft();
        }
        this._queueRender();
      };
    });
    this.shadowRoot
      .querySelector('[data-act="refresh"]')
      ?.addEventListener("click", () => this._load());
    this._bind();
  }

  _body() {
    if (this._tab === "history") return this._history();
    if (this._tab === "rules") return this._rules();
    if (this._tab === "editor") return this._editor();
    if (this._tab === "manual") return this._manual();
    if (this._tab === "settings") return this._settings();
    if (this._tab === "diag") return this._diag();
    return this._active();
  }

  _active() {
    const items = this._state.active || [];
    if (!items.length) {
      return `
        <section class="hero">
          <div class="check">✓</div>
          <div><h1>Brak aktywnych zdarzeń</h1><p>Wszystkie monitorowane warunki są obecnie w normie.</p></div>
        </section>
        <section class="empty"><div class="radar"></div><h2>SYSTEM MONITORUJE DOM</h2><p>Alarmy, ostrzeżenia i zadania pojawią się tutaj automatycznie.</p></section>`;
    }
    return `
      <div class="head"><div><small>LIVE QUEUE</small><h1>Aktywne powiadomienia</h1></div><b class="count">${items.length}</b></div>
      <div class="list">${items.map((item) => this._activeCard(item)).join("")}</div>`;
  }

  _activeCard(item) {
    const [icon, label, cls] = this._meta(item.level);
    return `
      <article class="notice ${cls}">
        <i></i><div class="nicon">${icon}</div>
        <div class="nbody">
          <div class="meta"><span>${label}</span><em>${this._e(item.category)}</em><em>${this._time(item.last_sent_at || item.created_at)}</em></div>
          <h2>${this._e(item.title)}</h2><p>${this._e(item.message)}</p>
          ${(item.matched_conditions || []).length > 1 ? `<div class="matched-summary"><span>SPEŁNIONE ENCJE</span>${item.matched_conditions.map((entry) => `<b>${this._e(entry.entity_name)}: ${this._e(entry.state_with_unit || entry.state)}</b>`).join("")}</div>` : ""}
          ${item.source_entity ? `<code>${this._e(item.source_entity)} <b>${this._e(item.source_state)}</b></code>` : ""}
        </div>
        <div class="actions">
          ${item.require_confirmation ? `<button class="primary" data-active="ack" data-id="${this._e(item.id)}">POTWIERDŹ</button>` : ""}
          <button data-active="snooze" data-id="${this._e(item.id)}">ODŁÓŻ 2H</button>
          <button data-active="dismiss" data-id="${this._e(item.id)}">ZAMKNIJ</button>
        </div>
      </article>`;
  }

  _history() {
    const query = this._historyQuery.trim().toLowerCase();
    const history = (this._state.history || []).filter((item) => {
      if (!query) return true;
      return `${item.event} ${item.title} ${item.message} ${item.actor}`.toLowerCase().includes(query);
    });
    return `
      <div class="head">
        <div><small>AUDIT LOG</small><h1>Historia zdarzeń</h1></div>
        <div class="history-tools">
          <input id="history-search" class="head-search" placeholder="Szukaj w historii…" value="${this._e(this._historyQuery)}">
          ${
            this._admin
              ? `<button class="history-clear-button" data-clear-history>🗑 WYCZYŚĆ HISTORIĘ</button>`
              : ""
          }
        </div>
      </div>
      <div class="timeline">${
        history.length
          ? history
              .map((item) => {
                const meta = this._meta(item.level);
                return `<div class="tl"><i class="${meta[2]}"></i><div><span><b>${this._e(item.event)}</b><time>${this._time(item.timestamp)}</time></span><h3>${this._e(item.title)}</h3>${item.message ? `<p>${this._e(item.message)}</p>` : ""}<small>Użytkownik: ${this._e(item.actor)}</small></div></div>`;
              })
              .join("")
          : `<div class="empty"><h2>Brak historii</h2></div>`
      }</div>`;
  }

  _rules() {
    const query = this._ruleQuery.toLowerCase();
    const rules = (this._state.rules || []).filter((rule) => {
      if (!query) return true;
      return `${rule.name} ${rule.title} ${this._humanLogic(rule.conditions)}`.toLowerCase().includes(query);
    });
    return `
      <div class="head">
        <div><small>AUTOMATION CORE</small><h1>Reguły powiadomień</h1></div>
        <div class="headtools"><input id="rq" placeholder="Szukaj reguły…" value="${this._e(this._ruleQuery)}"><button class="primary" data-new>+ NOWA REGUŁA</button></div>
      </div>
      <div class="grid">${rules.length ? rules.map((rule) => this._ruleCard(rule)).join("") : `<div class="empty"><h2>Brak reguł</h2></div>`}</div>`;
  }

  _conditionCount(node) {
    if (!node || typeof node !== "object") return 0;
    if (node.type !== "group") return 1;
    return (node.items || []).reduce((sum, item) => sum + this._conditionCount(item), 0);
  }

  _logicName(group) {
    const count = (group?.items || []).length;
    const threshold = Math.max(1, Number(group?.threshold || 1));
    const names = {
      and: "WSZYSTKIE (AND)",
      or: "DOWOLNY (OR)",
      none: "ŻADEN (NONE)",
      at_least: `CO NAJMNIEJ ${threshold} Z ${count}`,
      exactly: `DOKŁADNIE ${threshold} Z ${count}`,
      majority: "WIĘKSZOŚĆ",
      xor: "TYLKO JEDEN (XOR)",
    };
    return names[group?.logic] || names.and;
  }

  _conditionLabel(rule) {
    const root = rule.conditions || {};
    return `${root.negate ? "NIE · " : ""}${this._logicName(root)} · ${this._conditionCount(root)} WAR.`;
  }

  _firstEntity(node) {
    if (!node || typeof node !== "object") return null;
    if (node.type === "entity") return node;
    for (const item of node.items || []) {
      const found = this._firstEntity(item);
      if (found) return found;
    }
    return null;
  }

  _ruleCard(rule) {
    const [icon, label, cls] = this._meta(rule.level);
    const first = this._firstEntity(rule.conditions);
    const current = first ? this._hass.states[first.entity_id]?.state ?? "unavailable" : "—";
    return `
      <article class="rule">
        <div class="rtop"><span class="badge ${cls}">${icon} ${label}</span><label class="switch"><input data-toggle="${rule.id}" type="checkbox" ${rule.enabled ? "checked" : ""}><span></span></label></div>
        <h2>${this._e(rule.name)}</h2><p>${this._e(rule.title)}</p>
        <div class="cond"><code>${this._e(this._conditionLabel(rule))}</code><span>${this._e(first?.entity_id || "złożona logika")} <b>${this._e(current)}</b></span></div>
        <div class="tags"><span>${this._e(rule.category)}</span><span>${rule.duration_seconds}s</span><span>co ${rule.interval_minutes} min</span></div>
        <div class="cardacts"><button data-edit="${rule.id}">EDYTUJ</button><button data-duplicate-rule="${rule.id}">DUPLIKUJ</button><button data-test="${rule.id}">TESTUJ</button><button class="del" data-delete="${rule.id}">USUŃ</button></div>
      </article>`;
  }

  _uid() {
    return globalThis.crypto?.randomUUID?.() || `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  _newEntityCondition() {
    return {
      id: this._uid(),
      type: "entity",
      entity_id: "",
      operator: "stan równy",
      value: "",
      value2: "",
      compare_entity_id: "",
      negate: false,
      for_seconds: 0,
      case_sensitive: false,
      window_minutes: 5,
      hysteresis: 0,
      event_description: "",
      resolved_description: "",
      notify_on_resolved: false,
      resolved_require_confirmation: false,
      resolved_level: "same",
    };
  }

  _newTimeCondition() {
    return {
      id: this._uid(),
      type: "time",
      after: "00:00",
      before: "23:59",
      weekdays: [],
      negate: false,
      for_seconds: 0,
    };
  }

  _newGroup(empty = false) {
    return {
      id: this._uid(),
      type: "group",
      logic: "and",
      threshold: 1,
      negate: false,
      for_seconds: 0,
      collapsed: false,
      label: "",
      items: empty ? [] : [this._newEntityCondition()],
    };
  }

  _defaultPhoneOptions(requireConfirmation = true) {
    return {
      include_title_in_message: true,
      show_actions: true,
      sticky: Boolean(requireConfirmation),
      persistent_on_phone: false,
      subtitle: "",
      subject: "",
      channel: "auto",
      importance: "auto",
      vibration_pattern: "",
      led_color: "",
      timeout: 0,
      image: "",
      open_url: "/centrum-powiadomien?tab=powiadomienia",
    };
  }

  _normalizePhoneOptions(options, requireConfirmation = true) {
    return {
      ...this._defaultPhoneOptions(requireConfirmation),
      ...(options || {}),
      include_title_in_message: options?.include_title_in_message !== false,
      show_actions: options?.show_actions !== false,
      sticky: options?.sticky ?? Boolean(requireConfirmation),
      persistent_on_phone: Boolean(options?.persistent_on_phone),
      timeout: Math.max(0, Number(options?.timeout || 0)),
    };
  }

  _newDraft() {
    return {
      id: null,
      name: "",
      enabled: true,
      allow_duplicate_entities: false,
      include_matched_conditions: true,
      conditions: this._newGroup(),
      duration_seconds: 60,
      level: "zadanie",
      category: "Zadania",
      recipients: [],
      require_confirmation: true,
      repeat: true,
      interval_minutes: 60,
      signal: false,
      bypass_quiet_hours: false,
      ack_timeout_minutes: 0,
      phone_options: this._defaultPhoneOptions(true),
      kiosk_enabled: true,
      kiosk_targets: ["*"],
      kiosk_mode: "auto",
      kiosk_duration_seconds: 0,
      kiosk_wake: true,
      title: "",
      message: "",
    };
  }

  _normalizeDraft(draft) {
    if (!draft.conditions) {
      draft.conditions = this._newGroup(true);
      draft.conditions.items.push({
        ...this._newEntityCondition(),
        entity_id: draft.entity_id || "",
        operator: draft.operator || "stan równy",
        value: draft.value || "",
      });
    }
    draft.allow_duplicate_entities = Boolean(draft.allow_duplicate_entities);
    draft.include_matched_conditions = draft.include_matched_conditions !== false;
    draft.bypass_quiet_hours = Boolean(draft.bypass_quiet_hours);
    draft.kiosk_enabled = draft.kiosk_enabled !== false;
    draft.kiosk_targets = Array.isArray(draft.kiosk_targets)
      ? draft.kiosk_targets
      : String(draft.kiosk_targets || "*").split(",").map((value) => value.trim()).filter(Boolean);
    draft.kiosk_mode = ["auto", "banner", "card", "fullscreen"].includes(draft.kiosk_mode)
      ? draft.kiosk_mode
      : "auto";
    draft.kiosk_duration_seconds = Math.max(0, Number(draft.kiosk_duration_seconds || 0));
    draft.kiosk_wake = draft.kiosk_wake !== false;
    draft.phone_options = this._normalizePhoneOptions(
      draft.phone_options,
      draft.require_confirmation !== false
    );
    const fix = (node) => {
      if (!node.id) node.id = this._uid();
      node.negate = Boolean(node.negate);
      node.for_seconds = Number(node.for_seconds || 0);
      if (node.type === "group") {
        const valid = ["and", "or", "none", "at_least", "exactly", "majority", "xor"];
        node.logic = valid.includes(node.logic) ? node.logic : "and";
        node.threshold = Math.max(1, Number(node.threshold || 1));
        node.collapsed = Boolean(node.collapsed);
        node.label = node.label || "";
        node.items = (node.items || []).map(fix);
      } else if (node.type === "entity") {
        node.value2 = node.value2 || "";
        node.compare_entity_id = node.compare_entity_id || "";
        node.case_sensitive = Boolean(node.case_sensitive);
        node.window_minutes = Math.max(1, Number(node.window_minutes || 5));
        node.hysteresis = Math.max(0, Number(node.hysteresis || 0));
        node.event_description = node.event_description || "";
        node.resolved_description = node.resolved_description || "";
        node.notify_on_resolved = Boolean(node.notify_on_resolved);
        node.resolved_require_confirmation = Boolean(
          node.resolved_require_confirmation
        );
        node.resolved_level = [
          "same",
          "informacja",
          "zadanie",
          "ostrzezenie",
          "krytyczne",
        ].includes(node.resolved_level)
          ? node.resolved_level
          : "same";
      } else if (node.type === "time") {
        node.weekdays = node.weekdays || [];
      }
      return node;
    };
    draft.conditions = fix(draft.conditions);
    return draft;
  }

  _findNode(id, node = this._draft?.conditions, parent = null, index = -1) {
    if (!node) return null;
    if (node.id === id) return { node, parent, index };
    for (let itemIndex = 0; itemIndex < (node.items || []).length; itemIndex += 1) {
      const found = this._findNode(id, node.items[itemIndex], node, itemIndex);
      if (found) return found;
    }
    return null;
  }

  _collectUsedEntities(node = this._draft?.conditions, excludeNodeId = null) {
    const result = new Set();
    const scan = (item) => {
      if (!item || item.id === excludeNodeId) return;
      if (item.type === "entity") {
        if (item.entity_id) result.add(item.entity_id);
        if (item.compare_entity_id) result.add(item.compare_entity_id);
      }
      (item.items || []).forEach(scan);
    };
    scan(node);
    return result;
  }

  _cloneNode(node) {
    const clone = JSON.parse(JSON.stringify(node));
    const assignIds = (item) => {
      item.id = this._uid();
      (item.items || []).forEach(assignIds);
      return item;
    };
    return assignIds(clone);
  }

  _moveNode(id, delta) {
    const found = this._findNode(id);
    if (!found?.parent) return;
    const next = found.index + delta;
    if (next < 0 || next >= found.parent.items.length) return;
    const [node] = found.parent.items.splice(found.index, 1);
    found.parent.items.splice(next, 0, node);
  }

  _moveNodeTo(dragId, targetId) {
    if (!dragId || dragId === targetId) return;
    const drag = this._findNode(dragId);
    const target = this._findNode(targetId);
    if (!drag?.parent || !target?.parent || drag.parent.id !== target.parent.id) return;
    const [node] = drag.parent.items.splice(drag.index, 1);
    const refreshedTarget = this._findNode(targetId);
    const insertAt = refreshedTarget ? refreshedTarget.index : drag.parent.items.length;
    drag.parent.items.splice(insertAt, 0, node);
  }

  _nodePath(id, node = this._draft?.conditions, prefix = "1") {
    if (!node) return "";
    if (node.id === id) return prefix;
    for (let index = 0; index < (node.items || []).length; index += 1) {
      const path = this._nodePath(id, node.items[index], `${prefix}.${index + 1}`);
      if (path) return path;
    }
    return "";
  }

  _humanLogic(node) {
    if (!node) return "brak warunku";
    if (node.type === "group") {
      const children = (node.items || []).map((item) => this._humanLogic(item));
      const joined = children.join(node.logic === "or" ? " LUB " : " ORAZ ");
      return `${node.negate ? "NIE " : ""}[${this._logicName(node)}: ${joined || "pusto"}]`;
    }
    if (node.type === "time") {
      return `${node.negate ? "NIE " : ""}czas ${node.after || "00:00"}–${node.before || "23:59"}`;
    }
    const state = this._hass.states[node.entity_id];
    const name = state?.attributes?.friendly_name || node.entity_id || "brak encji";
    const target = node.compare_entity_id || [node.value, node.value2].filter(Boolean).join(" – ");
    return `${node.negate ? "NIE " : ""}${name} ${node.operator} ${target}`.trim();
  }

  _restoreDraft() {
    try {
      const raw = localStorage.getItem(this._draftStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return this._normalizeDraft(parsed);
    } catch {
      return null;
    }
  }

  _scheduleDraftSave() {
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => {
      try {
        if (this._draft) localStorage.setItem(this._draftStorageKey, JSON.stringify(this._draft));
      } catch {
        // Local storage is optional.
      }
    }, 250);
  }

  _clearStoredDraft() {
    try {
      localStorage.removeItem(this._draftStorageKey);
    } catch {
      // Ignore.
    }
  }

  _phoneOptionsEditor(options) {
    const opts = this._normalizePhoneOptions(options, this._draft?.require_confirmation);
    return `
      <details class="phone-options" open>
        <summary>OPCJE WYŚWIETLANIA NA TELEFONIE</summary>
        <div class="phone-options-grid">
          <label class="phone-check"><input type="checkbox" data-phone-check="include_title_in_message" ${opts.include_title_in_message ? "checked" : ""}> Umieść tytuł także w treści wiadomości</label>
          <label class="phone-check"><input type="checkbox" data-phone-check="show_actions" ${opts.show_actions ? "checked" : ""}> Pokaż przyciski POTWIERDŹ / ODŁÓŻ</label>
          <label class="phone-check"><input type="checkbox" data-phone-check="sticky" ${opts.sticky ? "checked" : ""}> Zachowaj po kliknięciu (sticky)</label>
          <label class="phone-check"><input type="checkbox" data-phone-check="persistent_on_phone" ${opts.persistent_on_phone ? "checked" : ""}> Nie pozwalaj usunąć przesunięciem (Android)</label>
          <label>Podtytuł — iOS<input data-phone-field="subtitle" value="${this._e(opts.subtitle)}" ${this._noAiAttrs()}></label>
          <label>Temat długiej treści — Android<input data-phone-field="subject" value="${this._e(opts.subject)}" ${this._noAiAttrs()}></label>
          <label>Kanał Android<input data-phone-field="channel" value="${this._e(opts.channel)}" placeholder="auto lub nazwa kanału"></label>
          <label>Ważność kanału<select data-phone-field="importance">${["auto", "default", "high", "max", "low", "min"].map((value) => `<option value="${value}" ${opts.importance === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
          <label>Wibracja<input data-phone-field="vibration_pattern" value="${this._e(opts.vibration_pattern)}" placeholder="100, 600, 100, 600"></label>
          <label>Kolor LED<input data-phone-field="led_color" value="${this._e(opts.led_color)}" placeholder="#ff315c"></label>
          <label>Automatyczne zamknięcie (s)<input type="number" min="0" max="86400" data-phone-field="timeout" value="${opts.timeout || 0}"></label>
          <label>Obraz / kamera<input data-phone-field="image" value="${this._e(opts.image)}" placeholder="/api/camera_proxy/camera.nazwa"></label>
          <label class="full">Adres po kliknięciu<input data-phone-field="open_url" value="${this._e(opts.open_url)}"></label>
        </div>
        <small>Ustawienia kanału Androida, takie jak ważność, wibracja i LED, są utrwalane przy pierwszym utworzeniu danego kanału.</small>
      </details>`;
  }

  _editor() {
    if (!this._draft) this._draft = this._restoreDraft() || this._newDraft();
    this._normalizeDraft(this._draft);
    const draft = this._draft;
    const recipients = Object.keys(this._state.settings?.recipients || {});
    const meta = this._meta(draft.level);
    return `
      <div class="head editor-head">
        <div><small>RULE BUILDER // LOGIKA ZŁOŻONA 2.0</small><h1>${draft.id ? "Edycja reguły" : "Nowa reguła"}</h1></div>
        <button data-cancel>ANULUJ</button>
      </div>
      <div class="editor-layout-v2">
        <div class="editor-main-stack">
          <section class="panel conditions-panel">
            <div class="panel-heading"><div><small>01 // WARUNKI I LOGIKA</small><h2>Kiedy wysłać powiadomienie?</h2></div><label class="duplicate-toggle"><input type="checkbox" data-f="allow_duplicate_entities" ${draft.allow_duplicate_entities ? "checked" : ""}><span>Zezwól na wielokrotne użycie encji</span></label></div>
            <div class="form rule-name-row"><label class="full">Nazwa reguły<input data-f="name" value="${this._e(draft.name)}" ${this._noAiAttrs()}></label></div>
            <div class="logic-summary"><span>LOGIKA</span><b>${this._e(this._humanLogic(draft.conditions))}</b></div>
            ${this._renderConditionGroup(draft.conditions, 0, true)}
            <label class="duration-field">Cała logika musi być spełniona przez (s)<input type="number" min="0" max="86400" data-f="duration_seconds" value="${draft.duration_seconds}"></label>
          </section>

          <section class="panel notification-panel">
            <div class="panel-heading"><div><small>02 // POWIADOMIENIE</small><h2>Co i do kogo wysłać?</h2></div></div>
            <div class="form notification-form">
              <label>Poziom<select data-f="level">${["informacja", "zadanie", "ostrzezenie", "krytyczne"].map((value) => `<option ${value === draft.level ? "selected" : ""}>${value}</option>`).join("")}</select></label>
              <label>Kategoria<select data-f="category">${["Bezpieczeństwo", "Pogoda i dom", "Zadania", "Techniczne", "Informacyjne"].map((value) => `<option ${value === draft.category ? "selected" : ""}>${value}</option>`).join("")}</select></label>
              <label class="full">Tytuł<input id="notification-title" data-f="title" value="${this._e(draft.title)}" ${this._noAiAttrs()}></label>
              <label class="full">Treść<textarea id="notification-message" data-f="message" ${this._noAiAttrs()}>${this._e(draft.message)}</textarea></label>
              <small class="full template-help">Zmienne: {{ rule_name }}, {{ entity_name }}, {{ state }}, {{ value }}, {{ conditions_summary }}, {{ matched_count }}, {{ matched_entities }}, {{ matched_entities_with_state }}, {{ matched_descriptions }}, {{ matched_entities_with_description }}, {{ matched_entity_ids }}, {{ matched_conditions }} oraz {{ state:sensor.dowolna_encja }}</small>
              <div class="full recips">${recipients.map((name) => `<label><input data-rec="${this._e(name)}" type="checkbox" ${draft.recipients.includes(name) ? "checked" : ""}> ${this._e(name)}</label>`).join("")}</div>
              ${this._toggle("Dołącz listę czujników, które spełniły warunek", "include_matched_conditions", draft.include_matched_conditions)}
              <small class="full template-help matched-help">Gdy warunek ma własny opis zdarzenia, wiadomość otrzyma go automatycznie, np. „• Zmywarka: Zmywarka pracuje”. Bez własnych opisów reguła grupowa pokaże stany czujników. Użycie zmiennej {{ matched_entities_with_description }} lub innej zmiennej matched_* wyłącza automatyczne dopisanie.</small>
              ${this._toggle("Wymaga potwierdzenia", "require_confirmation", draft.require_confirmation)}
              ${this._toggle("Powtarzaj, dopóki warunek trwa", "repeat", draft.repeat)}
              ${this._toggle("Ignoruj godziny ciszy nocnej", "bypass_quiet_hours", draft.bypass_quiet_hours)}
              ${this._toggle("Signal", "signal", draft.signal)}
              <label>Interwał (min)<input type="number" min="1" max="10080" data-f="interval_minutes" value="${draft.interval_minutes}"></label>
              <label>Kontrola po potwierdzeniu (min)<input type="number" min="0" max="10080" data-f="ack_timeout_minutes" value="${draft.ack_timeout_minutes}"></label>
              <div class="full">${this._phoneOptionsEditor(draft.phone_options)}</div>
              <details class="phone-options full" open>
                <summary>WYŚWIETLANIE NA PANELU KIOSKU</summary>
                <div class="phone-options-grid">
                  <label class="phone-check"><input type="checkbox" data-f="kiosk_enabled" ${draft.kiosk_enabled ? "checked" : ""}> Pokaż tę regułę na kiosku</label>
                  <label class="phone-check"><input type="checkbox" data-f="kiosk_wake" ${draft.kiosk_wake ? "checked" : ""}> Wybudź tablet przy ostrzeżeniu lub alarmie</label>
                  <label>Profile kiosku<input data-f="kiosk_targets" value="${this._e(draft.kiosk_targets.join(", "))}" placeholder="* albo salon, kuchnia"></label>
                  <label>Forma<select data-f="kiosk_mode">${[["auto", "automatyczna"], ["banner", "pasek"], ["card", "karta"], ["fullscreen", "pełny ekran"]].map(([value, label]) => `<option value="${value}" ${draft.kiosk_mode === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
                  <label>Czas widoczności (s)<input type="number" min="0" max="86400" data-f="kiosk_duration_seconds" value="${draft.kiosk_duration_seconds}"></label>
                </div>
                <small>Profil „*” oznacza wszystkie kioski. Wartość 0 używa czasu domyślnego dla poziomu.</small>
              </details>
            </div>
          </section>
        </div>

        <aside class="preview-v2 ${meta[2]}">
          <h3>03 // PODGLĄD NA ŻYWO</h3>
          <div class="logic-preview"><b>${this._e(this._logicName(draft.conditions))}</b><span>${this._conditionCount(draft.conditions)} warunków</span></div>
          <div class="phone">
            <small>HOME ASSISTANT</small>
            <em id="preview-subtitle">${this._e(draft.phone_options.subtitle || "")}</em>
            <h3 id="preview-title">${this._e(draft.title || "Tytuł powiadomienia")}</h3>
            <b id="preview-subject">${this._e(draft.phone_options.subject || "")}</b>
            <p id="preview-message"></p>
            <div id="preview-actions" class="${draft.require_confirmation && draft.phone_options.show_actions ? "" : "hidden"}"><span>POTWIERDŹ</span><span>ODŁÓŻ 2H</span></div>
          </div>
          <div class="preview-routing">Kliknięcie powiadomienia otworzy: <b>${this._e(draft.phone_options.open_url)}</b></div>
          <div class="test-phone-box"><label>Wyślij test na<select id="draft-test-recipient">${recipients.map((name) => `<option value="${this._e(name)}" ${name === this._testRecipient ? "selected" : ""}>${this._e(name)}</option>`).join("")}</select></label><button class="primary" data-send-test-draft>WYŚLIJ TEST NA TELEFON</button></div>
          ${this._renderTestResult()}
        </aside>
      </div>
      <div class="editor-actionbar">
        <div><b>AUTOZAPIS SZKICU</b><span>Formularz jest zapisywany lokalnie w przeglądarce.</span></div>
        <div><button data-test-draft>TESTUJ LOGIKĘ</button><button class="primary" data-save>ZAPISZ REGUŁĘ</button></div>
      </div>`;
  }

  _noAiAttrs() {
    return 'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" data-lpignore="true" data-1p-ignore="true"';
  }

  _renderTestResult() {
    if (!this._testResult) return "";
    const details = (this._testResult.details || []).filter((item) => item.type !== "group").slice(0, 12);
    return `
      <div class="test-result ${this._testResult.condition_met ? "passed" : "failed"}">
        <div><b>${this._testResult.condition_met ? "WARUNEK SPEŁNIONY" : "WARUNEK NIESPEŁNIONY"}</b><span>${this._e(this._testResult.summary || "")}</span></div>
        <ul>${details.map((detail) => `<li class="${detail.met ? "ok" : "bad"}"><span>${detail.met ? "✓" : "✕"}</span>${this._e(detail.label)}</li>`).join("")}</ul>
      </div>`;
  }

  _renderConditionGroup(group, depth = 0, root = false) {
    const path = this._nodePath(group.id);
    const thresholdLogic = ["at_least", "exactly"].includes(group.logic);
    const error = this._validationErrors.has(group.id) ? "has-error" : "";
    return `
      <div class="condition-group depth-${Math.min(depth, 5)} ${error}" data-group-id="${group.id}" data-node-wrapper="${group.id}">
        <div class="group-head-v2">
          <div class="group-identity">
            <button class="drag-handle" draggable="true" data-drag-node="${group.id}" title="Przeciągnij">⋮⋮</button>
            <button class="collapse-button" data-collapse-group="${group.id}">${group.collapsed ? "▸" : "▾"}</button>
            <div><b>${root ? "LOGIKA GŁÓWNA" : group.label || `GRUPA ${path}`}</b><small>${this._logicName(group)}${group.negate ? " · NEGACJA" : ""}</small></div>
          </div>
          <div class="group-controls">
            <select data-group-logic="${group.id}">
              ${[
                ["and", "WSZYSTKIE (AND)"],
                ["or", "DOWOLNY (OR)"],
                ["none", "ŻADEN (NONE)"],
                ["at_least", "CO NAJMNIEJ N Z M"],
                ["exactly", "DOKŁADNIE N Z M"],
                ["majority", "WIĘKSZOŚĆ"],
                ["xor", "TYLKO JEDEN (XOR)"],
              ].map(([value, label]) => `<option value="${value}" ${group.logic === value ? "selected" : ""}>${label}</option>`).join("")}
            </select>
            ${thresholdLogic ? `<label class="threshold-control">N <input type="number" min="1" max="${Math.max(1, (group.items || []).length)}" data-group-threshold="${group.id}" value="${group.threshold || 1}"></label>` : ""}
            <label class="mini-check"><input type="checkbox" data-group-negate="${group.id}" ${group.negate ? "checked" : ""}> NIE</label>
            <label class="mini-duration">przez <input type="number" min="0" max="86400" data-group-for="${group.id}" value="${group.for_seconds || 0}"> s</label>
          </div>
          <div class="node-tools">
            ${root ? "" : `<button data-move-up="${group.id}" title="W górę">↑</button><button data-move-down="${group.id}" title="W dół">↓</button><button data-duplicate-node="${group.id}" title="Duplikuj">⧉</button><button class="icon-danger" data-remove-node="${group.id}" title="Usuń">✕</button>`}
          </div>
        </div>
        ${
          group.collapsed
            ? `<div class="collapsed-summary">${this._e(this._humanLogic(group))}</div>`
            : `<div class="condition-items">${(group.items || []).map((item) => item.type === "group" ? this._renderConditionGroup(item, depth + 1, false) : this._renderCondition(item, depth + 1)).join("") || `<div class="group-empty">Dodaj pierwszy warunek.</div>`}</div>
               <div class="group-actions"><button data-add-entity="${group.id}">+ ENCJA</button><button data-add-time="${group.id}">+ CZAS</button>${depth < 5 ? `<button data-add-group="${group.id}">+ GRUPA</button>` : ""}</div>`
        }
      </div>`;
  }

  _renderCondition(condition, depth) {
    if (condition.type === "time") return this._renderTimeCondition(condition, depth);
    return this._renderEntityCondition(condition, depth);
  }

  _conditionHeader(condition, label) {
    return `
      <div class="condition-card-head">
        <div class="condition-identity"><button class="drag-handle" draggable="true" data-drag-node="${condition.id}">⋮⋮</button><b>${label}</b><small>${this._nodePath(condition.id)}</small></div>
        <div class="condition-head-options"><label><input type="checkbox" data-cond-negate="${condition.id}" ${condition.negate ? "checked" : ""}> NIE</label><label>przez <input type="number" min="0" max="86400" data-cond-for="${condition.id}" value="${condition.for_seconds || 0}"> s</label></div>
        <div class="node-tools"><button data-move-up="${condition.id}">↑</button><button data-move-down="${condition.id}">↓</button><button data-duplicate-node="${condition.id}">⧉</button><button class="icon-danger" data-remove-node="${condition.id}">✕</button></div>
      </div>`;
  }

  _renderTimeCondition(condition) {
    const days = [
      ["mon", "Pn"], ["tue", "Wt"], ["wed", "Śr"], ["thu", "Cz"], ["fri", "Pt"], ["sat", "So"], ["sun", "Nd"],
    ];
    const error = this._validationErrors.has(condition.id) ? "has-error" : "";
    return `
      <div class="condition-card time-card ${error}" data-node-wrapper="${condition.id}">
        ${this._conditionHeader(condition, "CZAS I DNI")}
        <div class="time-grid-v2">
          <label>Od<input type="time" data-cond-field="after" data-cond-id="${condition.id}" value="${this._e(condition.after || "00:00")}"></label>
          <label>Do<input type="time" data-cond-field="before" data-cond-id="${condition.id}" value="${this._e(condition.before || "23:59")}"></label>
          <div class="weekday-chips">${days.map(([id, text]) => `<label><input type="checkbox" data-cond-day="${id}" data-cond-id="${condition.id}" ${(condition.weekdays || []).includes(id) ? "checked" : ""}><span>${text}</span></label>`).join("")}</div>
        </div>
      </div>`;
  }

  _operatorOptions() {
    return [
      "stan równy", "stan różny", "jeden z", "żaden z", "zawiera", "nie zawiera",
      "powyżej", "poniżej", "większe lub równe", "mniejsze lub równe", "pomiędzy", "poza zakresem",
      "równe encji", "większe od encji", "mniejsze od encji",
      "dostępna", "niedostępna",
      "zmieniło się na", "zmieniło się z na", "zmieniło się o co najmniej", "zmieniło się w ciągu",
    ];
  }

  _renderEntityCondition(condition) {
    const state = this._hass.states[condition.entity_id];
    const sourceQuery = this._conditionQueries[`${condition.id}:source`] ?? condition.entity_id;
    const compareQuery = this._conditionQueries[`${condition.id}:compare`] ?? condition.compare_entity_id;
    const suggestions = this._suggest(condition.entity_id);
    const error = this._validationErrors.has(condition.id) ? "has-error" : "";
    const operator = condition.operator;
    const compareOperator = ["równe encji", "większe od encji", "mniejsze od encji"].includes(operator);
    const noValue = ["dostępna", "niedostępna"].includes(operator);
    const twoValues = ["pomiędzy", "poza zakresem", "zmieniło się z na"].includes(operator);
    const transitionOperator = ["zmieniło się na", "zmieniło się z na", "zmieniło się o co najmniej", "zmieniło się w ciągu"].includes(operator);
    const numericOperator = ["powyżej", "poniżej", "większe lub równe", "mniejsze lub równe", "pomiędzy", "poza zakresem"].includes(operator);
    return `
      <div class="condition-card entity-card ${error}" data-node-wrapper="${condition.id}">
        ${this._conditionHeader(condition, "ENCJA")}
        <div class="condition-main-grid">
          <div class="entity-search-wrap span-2">
            <label>Encja źródłowa</label>
            <input data-cond-query="${condition.id}" data-query-role="source" value="${this._e(sourceQuery)}" placeholder="Szukaj encji…" ${this._noAiAttrs()}>
            <div class="condition-results" data-cond-results="${condition.id}:source">${this._conditionEntityResults(condition.id, sourceQuery, "source")}</div>
            ${state ? `<small>${this._e(state.attributes?.friendly_name || condition.entity_id)} · <b>${this._e(state.state)}</b></small>` : ""}
          </div>
          <label>Operator<select data-cond-field="operator" data-cond-id="${condition.id}">${this._operatorOptions().map((value) => `<option ${value === operator ? "selected" : ""}>${value}</option>`).join("")}</select></label>
          ${
            noValue
              ? `<div class="operator-note">Ten operator nie wymaga wartości.</div>`
              : compareOperator
                ? `<div class="entity-search-wrap"><label>Porównaj z encją</label><input data-cond-query="${condition.id}" data-query-role="compare" value="${this._e(compareQuery)}" placeholder="Szukaj drugiej encji…" ${this._noAiAttrs()}><div class="condition-results" data-cond-results="${condition.id}:compare">${this._conditionEntityResults(condition.id, compareQuery, "compare")}</div>${condition.compare_entity_id ? `<small>${this._e(this._hass.states[condition.compare_entity_id]?.attributes?.friendly_name || condition.compare_entity_id)} · <b>${this._e(this._hass.states[condition.compare_entity_id]?.state ?? "unavailable")}</b></small>` : ""}</div>`
                : `<label>${operator === "jeden z" || operator === "żaden z" ? "Wartości oddzielone przecinkami" : operator === "zmieniło się w ciągu" ? "Minuty" : "Wartość"}<input data-cond-field="value" data-cond-id="${condition.id}" value="${this._e(condition.value || "")}" placeholder="wartość" ${this._noAiAttrs()}></label>${twoValues ? `<label>${operator === "zmieniło się z na" ? "Stan docelowy" : "Druga wartość"}<input data-cond-field="value2" data-cond-id="${condition.id}" value="${this._e(condition.value2 || "")}" placeholder="druga wartość" ${this._noAiAttrs()}></label>` : ""}`
          }
        </div>
        ${!noValue && !compareOperator ? `<div class="mini-chips">${suggestions.slice(0, 16).map((value) => `<button type="button" data-cond-state="${condition.id}" data-state-value="${this._e(value)}" class="${String(value) === String(condition.value) ? "on" : ""}">${this._e(value)}</button>`).join("")}</div>` : ""}
        <details class="condition-advanced">
          <summary>Ustawienia zaawansowane</summary>
          <div class="advanced-grid">
            <label><input type="checkbox" data-cond-checkbox="case_sensitive" data-cond-id="${condition.id}" ${condition.case_sensitive ? "checked" : ""}> Rozróżniaj wielkość liter</label>
            ${numericOperator ? `<label>Histereza<input type="number" min="0" step="0.1" data-cond-field="hysteresis" data-cond-id="${condition.id}" value="${condition.hysteresis || 0}"></label>` : ""}
            ${transitionOperator ? `<label>Okno zmiany (min)<input type="number" min="1" max="10080" data-cond-field="window_minutes" data-cond-id="${condition.id}" value="${condition.window_minutes || 5}"></label>` : ""}
            <label class="advanced-description">Opis, gdy warunek jest spełniony<textarea rows="2" data-cond-field="event_description" data-cond-id="${condition.id}" placeholder="np. Zmywarka pracuje" ${this._noAiAttrs()}>${this._e(condition.event_description || "")}</textarea></label>
            <label class="advanced-description">Opis po zakończeniu warunku<textarea rows="2" data-cond-field="resolved_description" data-cond-id="${condition.id}" placeholder="np. Koniec pracy — opróżnij zmywarkę" ${this._noAiAttrs()}>${this._e(condition.resolved_description || "")}</textarea></label>
            <label class="resolved-level-select">Poziom alarmu po zakończeniu
              <select data-cond-field="resolved_level" data-cond-id="${condition.id}" ${condition.notify_on_resolved ? "" : "disabled"}>
                ${[
                  ["same", "Taki jak pierwsze powiadomienie"],
                  ["informacja", "Informacja"],
                  ["zadanie", "Zadanie"],
                  ["ostrzezenie", "Ostrzeżenie"],
                  ["krytyczne", "Krytyczne"],
                ].map(([value, label]) => `<option value="${value}" ${value === (condition.resolved_level || "same") ? "selected" : ""}>${label}</option>`).join("")}
              </select>
            </label>
            <label class="advanced-resolved-toggle"><input type="checkbox" data-cond-checkbox="notify_on_resolved" data-cond-id="${condition.id}" ${condition.notify_on_resolved ? "checked" : ""}> Wyślij osobne powiadomienie po zakończeniu tego warunku</label>
            <label class="advanced-resolved-toggle resolved-confirm-toggle"><input type="checkbox" data-cond-checkbox="resolved_require_confirmation" data-cond-id="${condition.id}" ${condition.resolved_require_confirmation ? "checked" : ""} ${condition.notify_on_resolved ? "" : "disabled"}> Wymagaj potwierdzenia powiadomienia po zakończeniu</label>
            <small class="advanced-description-help">Poziom końcowy może być niezależny od pierwszego alarmu. „Krytyczne” użyje kanału alarmowego i ominie globalną ciszę nocną. Po włączeniu potwierdzenia komunikat trafi do Aktywnych i otrzyma przyciski POTWIERDŹ, ODŁÓŻ oraz POMIŃ. Zmienne: {{ entity_name }}, {{ entity_id }}, {{ state }}, {{ previous_state }} oraz {{ rule_name }}.</small>
          </div>
        </details>
      </div>`;
  }

  _conditionEntityResults(conditionId, query, role) {
    const normalized = String(query || "").trim().toLowerCase();
    const found = this._findNode(conditionId)?.node;
    const current = role === "compare" ? found?.compare_entity_id : found?.entity_id;
    if (!normalized || normalized === String(current || "").toLowerCase()) return "";
    const terms = normalized.split(/\s+/).filter(Boolean);
    const used = this._collectUsedEntities(this._draft.conditions, conditionId);
    if (found?.entity_id && role === "compare") used.add(found.entity_id);
    const allowDuplicates = Boolean(this._draft.allow_duplicate_entities);
    const results = Object.entries(this._hass.states)
      .filter(([entityId, state]) => {
        if (!allowDuplicates && used.has(entityId) && entityId !== current) return false;
        const haystack = `${entityId} ${state.attributes?.friendly_name || ""}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .sort((a, b) => {
        const left = a[1].attributes?.friendly_name || a[0];
        const right = b[1].attributes?.friendly_name || b[0];
        return left.localeCompare(right, "pl");
      })
      .slice(0, 50);
    return results.length
      ? results.map(([entityId, state]) => `<button type="button" data-cond-entity="${conditionId}" data-query-role="${role}" data-entity-value="${this._e(entityId)}"><span><b>${this._e(state.attributes?.friendly_name || entityId)}</b><code>${this._e(entityId)}</code></span><strong>${this._e(state.state)}</strong></button>`).join("")
      : `<p>Brak wyników. Użyte wcześniej encje są ukryte.</p>`;
  }

  _toggle(label, name, value) {
    return `<label class="toggle full"><span>${label}</span><label class="switch"><input data-f="${name}" type="checkbox" ${value ? "checked" : ""}><span></span></label></label>`;
  }

  _suggest(entityId) {
    const state = this._hass.states[entityId];
    if (!state) return [];
    const domain = entityId.split(".")[0];
    const values = [];
    const add = (value) => {
      if (value !== undefined && value !== null && value !== "" && !values.includes(String(value))) values.push(String(value));
    };
    add(state.state);
    (state.attributes?.options || []).forEach(add);
    (state.attributes?.hvac_modes || []).forEach(add);
    (state.attributes?.preset_modes || []).forEach(add);
    const common = {
      binary_sensor: ["on", "off"], switch: ["on", "off"], light: ["on", "off"], fan: ["on", "off"], input_boolean: ["on", "off"], automation: ["on", "off"],
      cover: ["open", "closed", "opening", "closing"], lock: ["locked", "unlocked", "locking", "unlocking", "jammed", "open"],
      person: ["home", "not_home"], device_tracker: ["home", "not_home"],
      alarm_control_panel: ["disarmed", "armed_home", "armed_away", "armed_night", "pending", "arming", "triggered"],
      media_player: ["off", "on", "idle", "playing", "paused", "standby"], vacuum: ["docked", "cleaning", "returning", "paused", "idle", "error"],
      timer: ["idle", "active", "paused"], sun: ["above_horizon", "below_horizon"],
    };
    (common[domain] || []).forEach(add);
    add("unknown");
    add("unavailable");
    return values;
  }

  _validateDraft() {
    const errors = new Set();
    const messages = [];
    if (!this._draft.name.trim()) messages.push("Brak nazwy reguły.");
    if (!this._draft.title.trim()) messages.push("Brak tytułu powiadomienia.");
    if (!this._draft.recipients.length && !this._draft.signal) messages.push("Wybierz odbiorcę albo Signal.");
    const used = new Map();
    const scan = (node) => {
      if (node.type === "group") {
        if (!(node.items || []).length) {
          errors.add(node.id);
          messages.push(`Grupa ${this._nodePath(node.id)} jest pusta.`);
        }
        if (["at_least", "exactly"].includes(node.logic) && Number(node.threshold || 1) > (node.items || []).length) {
          errors.add(node.id);
          messages.push(`Próg w grupie ${this._nodePath(node.id)} jest większy niż liczba warunków.`);
        }
        (node.items || []).forEach(scan);
        return;
      }
      if (node.type === "entity") {
        if (!node.entity_id) {
          errors.add(node.id);
          messages.push(`Warunek ${this._nodePath(node.id)} nie ma encji.`);
        }
        const noValue = ["dostępna", "niedostępna"].includes(node.operator);
        const compare = ["równe encji", "większe od encji", "mniejsze od encji"].includes(node.operator);
        if (!noValue && !compare && !String(node.value || "").trim()) {
          errors.add(node.id);
          messages.push(`Warunek ${this._nodePath(node.id)} nie ma wartości.`);
        }
        if (["pomiędzy", "poza zakresem", "zmieniło się z na"].includes(node.operator) && !String(node.value2 || "").trim()) {
          errors.add(node.id);
          messages.push(`Warunek ${this._nodePath(node.id)} wymaga drugiej wartości.`);
        }
        if (compare && !node.compare_entity_id) {
          errors.add(node.id);
          messages.push(`Warunek ${this._nodePath(node.id)} nie ma encji porównawczej.`);
        }
        if (node.entity_id) {
          if (!used.has(node.entity_id)) used.set(node.entity_id, []);
          used.get(node.entity_id).push(node.id);
        }
      }
    };
    scan(this._draft.conditions);
    if (!this._draft.allow_duplicate_entities) {
      for (const [entityId, ids] of used.entries()) {
        if (ids.length > 1) {
          ids.forEach((id) => errors.add(id));
          messages.push(`Encja ${entityId} została użyta kilka razy.`);
        }
      }
    }
    this._validationErrors = errors;
    return { valid: !messages.length, messages };
  }

  _manual() {
    const recipients = Object.keys(this._state.settings?.recipients || {});
    return `
      <div class="head"><div><small>DIRECT MESSAGE</small><h1>Wyślij powiadomienie</h1></div></div>
      <section class="panel manual"><div class="form">
        <label class="full">Tytuł<input id="mt" ${this._noAiAttrs()}></label>
        <label class="full">Treść<textarea id="mm" ${this._noAiAttrs()}></textarea></label>
        <label>Poziom<select id="ml">${["informacja", "zadanie", "ostrzezenie", "krytyczne"].map((value) => `<option>${value}</option>`).join("")}</select></label>
        <div class="full recips">${recipients.length ? recipients.map((name) => `<label><input data-mrec="${this._e(name)}" type="checkbox"> ${this._e(name)}</label>`).join("") : `<p class="no-recipients">Brak odbiorców telefonu — wiadomość może trafić tylko na kiosk.</p>`}</div>
        ${this._setToggle("Wymaga potwierdzenia", "mc", false)}
        ${this._setToggle("Powtarzaj", "mr", false)}
        ${this._setToggle("Ignoruj ciszę nocną dla powtórzeń", "mq", false)}
        ${this._setToggle("Signal", "ms", false)}
        <label>Interwał (min)<input id="mi" type="number" value="60"></label>
        <details class="phone-options full" open><summary>PANEL KIOSKU</summary><div class="phone-options-grid">
          <label class="phone-check"><input id="mkiosk" type="checkbox" checked> Pokaż na kiosku</label>
          <label class="phone-check"><input id="mkwake" type="checkbox" checked> Wybudź przy ostrzeżeniu lub alarmie</label>
          <label>Profile kiosku<input id="mktargets" value="*" placeholder="* albo salon, kuchnia"></label>
          <label>Forma<select id="mkmode"><option value="auto">automatyczna</option><option value="banner">pasek</option><option value="card">karta</option><option value="fullscreen">pełny ekran</option></select></label>
          <label>Czas widoczności (s)<input id="mkduration" type="number" min="0" max="86400" value="0"></label>
        </div></details>
        <details class="phone-options full"><summary>OPCJE WYŚWIETLANIA NA TELEFONIE</summary><div class="phone-options-grid">
          <label class="phone-check"><input id="mptitle" type="checkbox" checked> Umieść tytuł także w treści</label><label class="phone-check"><input id="mpactions" type="checkbox" checked> Pokaż przyciski akcji</label><label class="phone-check"><input id="mpsticky" type="checkbox"> Sticky</label><label class="phone-check"><input id="mppersistent" type="checkbox"> Nieusuwalne przesunięciem</label><label>Podtytuł<input id="mpsubtitle"></label><label>Temat Android<input id="mpsubject"></label><label>Kanał<input id="mpchannel" value="auto"></label><label>Ważność<select id="mpimportance">${["auto", "default", "high", "max", "low", "min"].map((value) => `<option>${value}</option>`).join("")}</select></label><label>Wibracja<input id="mpvibration" placeholder="100, 600, 100, 600"></label><label>Kolor LED<input id="mpled" placeholder="#ff315c"></label><label>Timeout (s)<input id="mptimeout" type="number" value="0"></label><label>Obraz<input id="mpimage"></label><label class="full">Adres po kliknięciu<input id="mpurl" value="/centrum-powiadomien?tab=powiadomienia"></label>
        </div></details>
      </div><button class="primary wide" data-send>WYŚLIJ TERAZ</button></section>`;
  }

  _ensureSettingsDraft() {
    if (this._settingsDraft) return this._settingsDraft;
    const settings = JSON.parse(JSON.stringify(this._state.settings || {}));
    this._settingsDraft = {
      enabled: settings.enabled !== false,
      persistent: settings.persistent !== false,
      signal_enabled: Boolean(settings.signal_enabled),
      quiet_enabled: Boolean(settings.quiet_enabled),
      quiet_start: settings.quiet_start || "22:00",
      quiet_end: settings.quiet_end || "07:00",
      signal_service: settings.signal_service || "",
      kiosk_enabled: settings.kiosk_enabled !== false,
      kiosk_min_level: settings.kiosk_min_level || "informacja",
      kiosk_info_duration: Number(settings.kiosk_info_duration ?? 8),
      kiosk_task_duration: Number(settings.kiosk_task_duration ?? 15),
      kiosk_warning_duration: Number(settings.kiosk_warning_duration ?? 30),
      kiosk_wake_enabled: Boolean(settings.kiosk_wake_enabled),
      kiosk_wake_entity: settings.kiosk_wake_entity || "",
      users: Object.entries(settings.recipients || {}).map(([name, config]) => ({
        key: this._uid(),
        name,
        service: config.service || "",
        enabled: config.enabled !== false,
        admin: Boolean(config.admin),
        ha_user_id: config.ha_user_id || "",
      })),
    };
    return this._settingsDraft;
  }

  _captureSettingsForm() {
    if (!this._settingsDraft) return;
    const root = this.shadowRoot;
    const value = (selector, fallback = "") => root.querySelector(selector)?.value ?? fallback;
    const checked = (selector, fallback = false) => root.querySelector(selector)?.checked ?? fallback;
    this._settingsDraft.enabled = checked("#se", this._settingsDraft.enabled);
    this._settingsDraft.persistent = checked("#sp", this._settingsDraft.persistent);
    this._settingsDraft.signal_enabled = checked("#ss", this._settingsDraft.signal_enabled);
    this._settingsDraft.quiet_enabled = checked("#sq", this._settingsDraft.quiet_enabled);
    this._settingsDraft.quiet_start = value("#q1", this._settingsDraft.quiet_start);
    this._settingsDraft.quiet_end = value("#q2", this._settingsDraft.quiet_end);
    this._settingsDraft.signal_service = value("#sigserv", this._settingsDraft.signal_service);
    this._settingsDraft.kiosk_enabled = checked("#ske", this._settingsDraft.kiosk_enabled);
    this._settingsDraft.kiosk_min_level = value("#skl", this._settingsDraft.kiosk_min_level);
    this._settingsDraft.kiosk_info_duration = Number(value("#skinfo", this._settingsDraft.kiosk_info_duration));
    this._settingsDraft.kiosk_task_duration = Number(value("#sktask", this._settingsDraft.kiosk_task_duration));
    this._settingsDraft.kiosk_warning_duration = Number(value("#skwarning", this._settingsDraft.kiosk_warning_duration));
    this._settingsDraft.kiosk_wake_enabled = checked("#skwake", this._settingsDraft.kiosk_wake_enabled);
    this._settingsDraft.kiosk_wake_entity = value("#skentity", this._settingsDraft.kiosk_wake_entity);
    this._settingsDraft.users.forEach((user, index) => {
      user.name = value(`[data-user-name="${index}"]`, user.name);
      user.service = value(`[data-user-service="${index}"]`, user.service);
      user.ha_user_id = value(`[data-user-ha="${index}"]`, user.ha_user_id);
      user.enabled = checked(`[data-user-enabled="${index}"]`, user.enabled);
      user.admin = checked(`[data-user-admin="${index}"]`, user.admin);
    });
  }

  _settings() {
    const settings = this._ensureSettingsDraft();
    const haUsers = this._state.ha_users || [];
    const current = this._state.current_user || {};
    return `
      <div class="head"><div><small>SYSTEM CONFIG</small><h1>Ustawienia</h1></div></div>
      <div class="setgrid">
        <section class="panel"><h3>TRYBY I KANAŁY</h3>
          ${this._setToggle("Centrum włączone", "se", settings.enabled)}${this._setToggle("Powiadomienia trwałe w HA", "sp", settings.persistent)}${this._setToggle("Signal", "ss", settings.signal_enabled)}${this._setToggle("Godziny ciszy", "sq", settings.quiet_enabled)}
          <div class="form"><label>Cisza od<input id="q1" type="time" value="${settings.quiet_start}"></label><label>Cisza do<input id="q2" type="time" value="${settings.quiet_end}"></label><label class="full">Usługa Signal<input id="sigserv" value="${this._e(settings.signal_service)}"></label></div>
        </section>
        <section class="panel"><small>MATRIX BRIDGE</small><h3>PANEL KIOSKU</h3>
          ${this._setToggle("Wysyłaj komunikaty do Energy Center", "ske", settings.kiosk_enabled)}
          ${this._setToggle("Wybudzaj tablet dla ostrzeżeń i alarmów", "skwake", settings.kiosk_wake_enabled)}
          <div class="form">
            <label>Minimalny poziom<select id="skl">${["informacja", "zadanie", "ostrzezenie", "krytyczne"].map((value) => `<option ${settings.kiosk_min_level === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
            <label>Encja ekranu<input id="skentity" value="${this._e(settings.kiosk_wake_entity)}" placeholder="switch.tablet_screen"></label>
            <label>Informacja (s)<input id="skinfo" type="number" min="0" max="86400" value="${settings.kiosk_info_duration}"></label>
            <label>Zadanie (s)<input id="sktask" type="number" min="0" max="86400" value="${settings.kiosk_task_duration}"></label>
            <label>Ostrzeżenie (s)<input id="skwarning" type="number" min="0" max="86400" value="${settings.kiosk_warning_duration}"></label>
          </div><p class="settings-note">Alarm krytyczny pozostaje na ekranie do wykonania akcji. Wybudzanie wymaga encji, którą Home Assistant potrafi włączyć.</p>
        </section>
        <section class="panel users-panel"><div class="panel-heading"><div><small>USERS & DEVICES</small><h3>UŻYTKOWNICY CENTRUM</h3></div><button data-add-user>+ DODAJ UŻYTKOWNIKA</button></div><p class="settings-note">Administrator Centrum może tworzyć reguły i zmieniać ustawienia tego panelu. Nie nadaje to uprawnień administratora całego Home Assistant.</p><p class="current-user">Zalogowany: <b>${this._e(current.name || "brak")}</b> · ID: <code>${this._e(current.id || "brak")}</code></p><div class="users-list">${settings.users.map((user, index) => `<article class="user-config"><div class="user-config-head"><b>UŻYTKOWNIK ${index + 1}</b><button class="icon-danger" data-remove-user="${index}" ${settings.users.length <= 1 ? "disabled" : ""}>USUŃ</button></div><div class="user-config-grid"><label>Nazwa<input data-user-name="${index}" value="${this._e(user.name)}" ${this._noAiAttrs()}></label><label>Usługa notify<input data-user-service="${index}" value="${this._e(user.service)}" placeholder="notify.mobile_app_telefon"></label><label>Powiązany użytkownik HA<select data-user-ha="${index}"><option value="">Brak powiązania — tylko odbiorca</option>${haUsers.map((haUser) => `<option value="${this._e(haUser.id)}" ${haUser.id === user.ha_user_id ? "selected" : ""}>${this._e(haUser.name)}${haUser.is_admin ? " · ADMIN HA" : ""}</option>`).join("")}</select></label><div class="user-flags"><label><input data-user-enabled="${index}" type="checkbox" ${user.enabled ? "checked" : ""}> Aktywny odbiorca</label><label><input data-user-admin="${index}" type="checkbox" ${user.admin ? "checked" : ""}> Administrator Centrum</label></div><div class="user-actions"><button data-use-current="${index}">POWIĄŻ ZE MNĄ</button><button data-test-user="${index}">TEST</button></div></div></article>`).join("")}</div><div class="signal-test"><b>Signal</b><button data-test-service data-service-source="signal">TEST</button></div></section>
      </div><button class="primary save-settings" data-savesettings>ZAPISZ USTAWIENIA</button>`;
  }

  _setToggle(label, id, value) {
    return `<label class="toggle"><span>${label}</span><input id="${id}" type="checkbox" ${value ? "checked" : ""}></label>`;
  }

  _diag() {
    const diagnostics = this._state.diagnostics || {};
    return `<div class="head"><div><small>SYSTEM HEALTH</small><h1>Diagnostyka</h1></div><button data-eval>SPRAWDŹ REGUŁY TERAZ</button></div><div class="diag">${[
      ["Uruchomiono", this._time(diagnostics.started_at), "⚡"], ["Ostatni przebieg", this._time(diagnostics.last_run), "🔄"], ["Reguły", `${diagnostics.enabled_rules || 0} / ${diagnostics.rules || 0}`, "🧠"], ["Aktywne", diagnostics.active || 0, "🔔"], ["Historia", diagnostics.history || 0, "🕘"], ["Błąd", diagnostics.last_error || "brak", diagnostics.last_error ? "❌" : "✅"],
    ].map((item) => `<div><span>${item[2]}</span><small>${item[0]}</small><b>${this._e(item[1])}</b></div>`).join("")}</div><section class="panel"><h3>USŁUGI POWIADOMIEŃ</h3>${Object.entries(diagnostics.services || {}).map(([name, ok]) => `<p class="service"><span>${name}</span><b class="${ok ? "ok" : "bad"}">${ok ? "ONLINE" : "BRAK USŁUGI"}</b></p>`).join("")}</section>`;
  }

  _bind() {
    this.shadowRoot.querySelectorAll("[data-active]").forEach((button) => {
      button.onclick = async () => {
        const action = button.dataset.active;
        const id = button.dataset.id;
        if (action === "ack") await this._api("POST", `active/${id}/ack`, {});
        if (action === "snooze") await this._api("POST", `active/${id}/snooze`, { minutes: 120 });
        if (action === "dismiss") await this._api("POST", `active/${id}/dismiss`, {});
        await this._load(false);
      };
    });

    if (this._tab === "history") {
      const input = this.shadowRoot.querySelector("#history-search");
      if (input) {
        input.oninput = (event) => {
          this._historyQuery = event.target.value;
          this._queueRender();
        };
        if (this._historyQuery) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }

      const clearButton = this.shadowRoot.querySelector("[data-clear-history]");
      if (clearButton) {
        clearButton.onclick = async () => {
          const count = Number(this._state?.diagnostics?.history || 0);
          const accepted = window.confirm(
            count > 0
              ? `Usunąć całą historię Centrum Powiadomień (${count} wpisów)?\n\nReguły i aktywne powiadomienia pozostaną bez zmian.`
              : "Historia jest już pusta."
          );
          if (!accepted || count === 0) return;

          try {
            const result = await this._api("POST", "clear_history", {});
            this._historyQuery = "";
            this._toast(
              `Historia została wyczyszczona. Usunięto: ${result.removed || count} wpisów.`
            );
            await this._load(false);
          } catch (error) {
            this._toast(
              `Nie udało się wyczyścić historii: ${error.message || error}`,
              true
            );
          }
        };
      }
    }

    if (this._tab === "rules") this._bindRules();
    if (this._tab === "editor") this._bindEditor();
    if (this._tab === "manual") this._bindManual();
    if (this._tab === "settings") this._bindSettings();
    if (this._tab === "diag") this._bindDiagnostics();
  }

  _bindRules() {
    const search = this.shadowRoot.querySelector("#rq");
    if (search) {
      search.oninput = (event) => {
        this._ruleQuery = event.target.value;
        this._queueRender();
      };
      if (this._ruleQuery) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      }
    }
    this.shadowRoot.querySelector("[data-new]")?.addEventListener("click", () => {
      this._draft = this._newDraft();
      this._conditionQueries = {};
      this._validationErrors.clear();
      this._testResult = null;
      this._tab = "editor";
      this._scheduleDraftSave();
      this._queueRender();
    });
    this.shadowRoot.querySelectorAll("[data-edit]").forEach((button) => {
      button.onclick = () => {
        this._draft = this._normalizeDraft(JSON.parse(JSON.stringify(this._state.rules.find((rule) => rule.id === button.dataset.edit))));
        this._conditionQueries = {};
        this._validationErrors.clear();
        this._testResult = null;
        this._tab = "editor";
        this._scheduleDraftSave();
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-duplicate-rule]").forEach((button) => {
      button.onclick = () => {
        const source = JSON.parse(JSON.stringify(this._state.rules.find((rule) => rule.id === button.dataset.duplicateRule)));
        source.id = null;
        source.name = `${source.name} — kopia`;
        source.conditions = this._cloneNode(source.conditions);
        this._draft = this._normalizeDraft(source);
        this._conditionQueries = {};
        this._tab = "editor";
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((input) => {
      input.onchange = async () => {
        await this._api("POST", `rules/${input.dataset.toggle}/toggle`, { enabled: input.checked });
        await this._load(false);
      };
    });
    this.shadowRoot.querySelectorAll("[data-test]").forEach((button) => {
      button.onclick = async () => {
        const result = await this._api("POST", `rules/${button.dataset.test}/test`, {});
        const failed = (result.details || []).filter((item) => item.type !== "group" && !item.met).slice(0, 3).map((item) => item.label).join(" | ");
        this._toast(`${result.condition_met ? "WARUNEK SPEŁNIONY" : "Warunek niespełniony"} · ${result.summary || result.current_state}${failed ? ` · ${failed}` : ""}`);
      };
    });
    this.shadowRoot.querySelectorAll("[data-delete]").forEach((button) => {
      button.onclick = async () => {
        if (confirm("Usunąć regułę?")) {
          await this._api("DELETE", `rules/${button.dataset.delete}`);
          await this._load(false);
        }
      };
    });
  }

  _bindEditor() {
    this.shadowRoot.querySelectorAll("[data-f]").forEach((element) => {
      const update = () => {
        const name = element.dataset.f;
        this._draft[name] = element.type === "checkbox" ? element.checked : element.type === "number" ? Number(element.value) : element.value;
        this._scheduleDraftSave();
        if (name === "title" || name === "message") this._updatePreview();
      };
      element.oninput = update;
      element.onchange = () => {
        update();
        if (["level", "require_confirmation", "allow_duplicate_entities", "include_matched_conditions"].includes(element.dataset.f)) this._queueRender();
      };
    });

    this.shadowRoot.querySelectorAll("[data-phone-field]").forEach((element) => {
      const update = () => {
        const key = element.dataset.phoneField;
        this._draft.phone_options[key] = element.type === "number" ? Number(element.value) : element.value;
        this._scheduleDraftSave();
        this._updatePreview();
      };
      element.oninput = update;
      element.onchange = update;
    });
    this.shadowRoot.querySelectorAll("[data-phone-check]").forEach((element) => {
      element.onchange = () => {
        this._draft.phone_options[element.dataset.phoneCheck] = element.checked;
        this._scheduleDraftSave();
        this._updatePreview();
      };
    });

    this.shadowRoot.querySelectorAll("[data-rec]").forEach((element) => {
      element.onchange = () => {
        const selected = new Set(this._draft.recipients);
        element.checked ? selected.add(element.dataset.rec) : selected.delete(element.dataset.rec);
        this._draft.recipients = [...selected];
        this._scheduleDraftSave();
      };
    });

    this.shadowRoot.querySelectorAll("[data-group-logic]").forEach((element) => {
      element.onchange = () => {
        const found = this._findNode(element.dataset.groupLogic);
        if (found) found.node.logic = element.value;
        this._scheduleDraftSave();
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-group-threshold]").forEach((element) => {
      element.oninput = () => {
        const found = this._findNode(element.dataset.groupThreshold);
        if (found) found.node.threshold = Number(element.value);
        this._scheduleDraftSave();
      };
    });
    this.shadowRoot.querySelectorAll("[data-group-negate]").forEach((element) => {
      element.onchange = () => {
        const found = this._findNode(element.dataset.groupNegate);
        if (found) found.node.negate = element.checked;
        this._scheduleDraftSave();
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-group-for]").forEach((element) => {
      element.oninput = () => {
        const found = this._findNode(element.dataset.groupFor);
        if (found) found.node.for_seconds = Number(element.value);
        this._scheduleDraftSave();
      };
    });
    this.shadowRoot.querySelectorAll("[data-collapse-group]").forEach((button) => {
      button.onclick = () => {
        const found = this._findNode(button.dataset.collapseGroup);
        if (found) found.node.collapsed = !found.node.collapsed;
        this._scheduleDraftSave();
        this._queueRender();
      };
    });

    this.shadowRoot.querySelectorAll("[data-add-entity]").forEach((button) => {
      button.onclick = () => {
        const found = this._findNode(button.dataset.addEntity);
        if (found) found.node.items.push(this._newEntityCondition());
        this._scheduleDraftSave();
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-add-time]").forEach((button) => {
      button.onclick = () => {
        const found = this._findNode(button.dataset.addTime);
        if (found) found.node.items.push(this._newTimeCondition());
        this._scheduleDraftSave();
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-add-group]").forEach((button) => {
      button.onclick = () => {
        const found = this._findNode(button.dataset.addGroup);
        if (found) found.node.items.push(this._newGroup());
        this._scheduleDraftSave();
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-remove-node]").forEach((button) => {
      button.onclick = () => {
        const found = this._findNode(button.dataset.removeNode);
        if (found?.parent) found.parent.items = found.parent.items.filter((item) => item.id !== found.node.id);
        Object.keys(this._conditionQueries).filter((key) => key.startsWith(`${button.dataset.removeNode}:`)).forEach((key) => delete this._conditionQueries[key]);
        this._scheduleDraftSave();
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-duplicate-node]").forEach((button) => {
      button.onclick = () => {
        const found = this._findNode(button.dataset.duplicateNode);
        if (found?.parent) found.parent.items.splice(found.index + 1, 0, this._cloneNode(found.node));
        this._scheduleDraftSave();
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-move-up]").forEach((button) => {
      button.onclick = () => {
        this._moveNode(button.dataset.moveUp, -1);
        this._scheduleDraftSave();
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-move-down]").forEach((button) => {
      button.onclick = () => {
        this._moveNode(button.dataset.moveDown, 1);
        this._scheduleDraftSave();
        this._queueRender();
      };
    });

    this.shadowRoot.querySelectorAll("[data-cond-negate]").forEach((element) => {
      element.onchange = () => {
        const found = this._findNode(element.dataset.condNegate);
        if (found) found.node.negate = element.checked;
        this._scheduleDraftSave();
      };
    });
    this.shadowRoot.querySelectorAll("[data-cond-for]").forEach((element) => {
      element.oninput = () => {
        const found = this._findNode(element.dataset.condFor);
        if (found) found.node.for_seconds = Number(element.value);
        this._scheduleDraftSave();
      };
    });
    this.shadowRoot.querySelectorAll("[data-cond-field]").forEach((element) => {
      const update = () => {
        const found = this._findNode(element.dataset.condId);
        if (!found) return;
        const value = element.type === "number" ? Number(element.value) : element.value;
        found.node[element.dataset.condField] = value;
        this._scheduleDraftSave();
      };
      element.oninput = update;
      element.onchange = () => {
        update();
        if (element.dataset.condField === "operator") this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-cond-checkbox]").forEach((element) => {
      element.onchange = () => {
        const found = this._findNode(element.dataset.condId);
        if (found) found.node[element.dataset.condCheckbox] = element.checked;
        this._scheduleDraftSave();
        if (element.dataset.condCheckbox === "notify_on_resolved") {
          this._queueRender();
        }
      };
    });
    this.shadowRoot.querySelectorAll("[data-cond-day]").forEach((element) => {
      element.onchange = () => {
        const found = this._findNode(element.dataset.condId);
        if (!found) return;
        const selected = new Set(found.node.weekdays || []);
        element.checked ? selected.add(element.dataset.condDay) : selected.delete(element.dataset.condDay);
        found.node.weekdays = [...selected];
        this._scheduleDraftSave();
      };
    });

    this.shadowRoot.querySelectorAll("[data-cond-query]").forEach((element) => {
      element.oninput = (event) => {
        const id = element.dataset.condQuery;
        const role = element.dataset.queryRole;
        this._conditionQueries[`${id}:${role}`] = event.target.value;
        const box = this.shadowRoot.querySelector(`[data-cond-results="${id}:${role}"]`);
        if (box) box.innerHTML = this._conditionEntityResults(id, event.target.value, role);
        this._bindConditionEntityResults();
      };
    });
    this._bindConditionEntityResults();
    this.shadowRoot.querySelectorAll("[data-cond-state]").forEach((button) => {
      button.onclick = () => {
        const found = this._findNode(button.dataset.condState);
        if (found) found.node.value = button.dataset.stateValue;
        this._scheduleDraftSave();
        this._queueRender();
      };
    });

    this.shadowRoot.querySelectorAll("[data-drag-node]").forEach((handle) => {
      handle.ondragstart = (event) => {
        this._dragNodeId = handle.dataset.dragNode;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", this._dragNodeId);
      };
    });
    this.shadowRoot.querySelectorAll("[data-node-wrapper]").forEach((wrapper) => {
      wrapper.ondragover = (event) => {
        event.preventDefault();
        wrapper.classList.add("drag-over");
      };
      wrapper.ondragleave = () => wrapper.classList.remove("drag-over");
      wrapper.ondrop = (event) => {
        event.preventDefault();
        wrapper.classList.remove("drag-over");
        const dragId = this._dragNodeId || event.dataTransfer.getData("text/plain");
        this._moveNodeTo(dragId, wrapper.dataset.nodeWrapper);
        this._dragNodeId = null;
        this._scheduleDraftSave();
        this._queueRender();
      };
    });

    this.shadowRoot.querySelector("[data-cancel]")?.addEventListener("click", () => {
      this._draft = null;
      this._conditionQueries = {};
      this._validationErrors.clear();
      this._testResult = null;
      this._clearStoredDraft();
      this._tab = "rules";
      this._queueRender();
    });
    this.shadowRoot.querySelector("[data-test-draft]")?.addEventListener("click", () => this._testDraft());
    this.shadowRoot.querySelector("[data-send-test-draft]")?.addEventListener("click", () => this._sendTestDraft());
    this.shadowRoot.querySelector("#draft-test-recipient")?.addEventListener("change", (event) => {
      this._testRecipient = event.target.value;
    });
    this.shadowRoot.querySelector("[data-save]")?.addEventListener("click", () => this._saveDraft());
    this._updatePreview();
  }

  _bindConditionEntityResults() {
    this.shadowRoot.querySelectorAll("[data-cond-entity]").forEach((button) => {
      button.onclick = () => {
        const id = button.dataset.condEntity;
        const role = button.dataset.queryRole;
        const found = this._findNode(id);
        if (found) {
          if (role === "compare") found.node.compare_entity_id = button.dataset.entityValue;
          else found.node.entity_id = button.dataset.entityValue;
          this._conditionQueries[`${id}:${role}`] = button.dataset.entityValue;
        }
        this._scheduleDraftSave();
        this._queueRender();
      };
    });
  }

  async _testDraft() {
    const validation = this._validateDraft();
    if (!validation.valid) {
      this._toast(validation.messages[0], true);
      this._queueRender();
      return;
    }
    try {
      this._testResult = await this._api("POST", "test_draft", this._draft);
      this._queueRender();
      this._toast(this._testResult.condition_met ? "Cała logika jest spełniona." : "Logika nie jest obecnie spełniona.");
    } catch (error) {
      this._toast(`Błąd testu: ${error.message || error}`, true);
    }
  }

  async _sendTestDraft() {
    const validation = this._validateDraft();
    if (!validation.valid) {
      this._toast(validation.messages[0], true);
      this._queueRender();
      return;
    }
    if (!this._testRecipient) {
      this._toast("Wybierz urządzenie testowe.", true);
      return;
    }
    try {
      const result = await this._api("POST", "send_test_draft", {
        draft: this._draft,
        recipient: this._testRecipient,
      });
      this._toast(
        result.success
          ? `Wysłano test na: ${this._testRecipient}`
          : result.error || "Nie udało się wysłać testu.",
        !result.success
      );
    } catch (error) {
      this._toast(`Błąd wysyłania testu: ${error.message || error}`, true);
    }
  }

  async _saveDraft() {
    const validation = this._validateDraft();
    if (!validation.valid) {
      this._toast(validation.messages[0], true);
      this._queueRender();
      setTimeout(() => this.shadowRoot.querySelector(".has-error")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
      return;
    }
    try {
      await this._api("POST", "rules", this._draft);
      this._draft = null;
      this._conditionQueries = {};
      this._validationErrors.clear();
      this._testResult = null;
      this._clearStoredDraft();
      this._tab = "rules";
      await this._load(false);
      this._toast("Reguła złożona została zapisana.");
    } catch (error) {
      this._toast(`Błąd zapisu: ${error.message || error}`, true);
    }
  }

  _updatePreview() {
    const title = this.shadowRoot.querySelector("#preview-title");
    const message = this.shadowRoot.querySelector("#preview-message");
    const subtitle = this.shadowRoot.querySelector("#preview-subtitle");
    const subject = this.shadowRoot.querySelector("#preview-subject");
    const actions = this.shadowRoot.querySelector("#preview-actions");
    const options = this._normalizePhoneOptions(
      this._draft?.phone_options,
      this._draft?.require_confirmation
    );
    if (title) title.textContent = this._draft?.title || "Tytuł powiadomienia";
    if (subtitle) {
      subtitle.textContent = options.subtitle || "";
      subtitle.classList.toggle("hidden", !options.subtitle);
    }
    if (subject) {
      subject.textContent = options.subject || "";
      subject.classList.toggle("hidden", !options.subject);
    }
    if (actions) {
      actions.classList.toggle(
        "hidden",
        !(this._draft?.require_confirmation && options.show_actions)
      );
    }
    if (message) {
      let preview = this._draft?.message || "Treść powiadomienia";
      const usesVariable = preview.includes("{{ matched_") || preview.includes("{{ first_matched_");
      if (this._draft?.include_matched_conditions && !usesVariable) {
        const matched = (this._testResult?.details || []).filter(
          (item) => item.type === "entity" && item.met
        );
        const described = matched.filter((item) => item.event_description);
        if (described.length) {
          const lines = described.slice(0, 5).map(
            (item) => `• ${item.entity_name}: ${item.event_description}`
          );
          preview += `\n\nSzczegóły zdarzenia:\n${lines.join("\n")}`;
        } else {
          const draftDescriptions = [];
          const scanDescriptions = (node) => {
            if (node?.type === "entity" && node.event_description) {
              const state = this._hass.states[node.entity_id];
              draftDescriptions.push(
                `• ${state?.attributes?.friendly_name || node.entity_id || "Encja"}: ${node.event_description}`
              );
            }
            (node?.items || []).forEach(scanDescriptions);
          };
          scanDescriptions(this._draft?.conditions);
          if (draftDescriptions.length) {
            preview += `\n\nSzczegóły zdarzenia:\n${draftDescriptions.slice(0, 5).join("\n")}`;
          } else {
            const lines = matched.length
              ? matched.slice(0, 5).map((item) => `• ${item.entity_name}: ${item.current}${item.unit ? ` ${item.unit}` : ""}`)
              : ["• Przykładowy czujnik baterii: 8%"];
            preview += `\n\nSpełnione czujniki:\n${lines.join("\n")}`;
          }
        }
      }
      if (options.include_title_in_message && this._draft?.title) {
        preview = `${this._draft.title}\n\n${preview}`;
      }
      message.textContent = preview;
    }
  }

  _bindManual() {
    this.shadowRoot.querySelector("[data-send]")?.addEventListener("click", async () => {
      const recipients = [...this.shadowRoot.querySelectorAll("[data-mrec]:checked")].map((item) => item.dataset.mrec);
      const body = {
        title: this.shadowRoot.querySelector("#mt").value,
        message: this.shadowRoot.querySelector("#mm").value,
        level: this.shadowRoot.querySelector("#ml").value,
        recipients,
        require_confirmation: this.shadowRoot.querySelector("#mc").checked,
        repeat: this.shadowRoot.querySelector("#mr").checked,
        bypass_quiet_hours: this.shadowRoot.querySelector("#mq").checked,
        signal: this.shadowRoot.querySelector("#ms").checked,
        interval_minutes: Number(this.shadowRoot.querySelector("#mi").value),
        kiosk_enabled: this.shadowRoot.querySelector("#mkiosk").checked,
        kiosk_targets: this.shadowRoot.querySelector("#mktargets").value,
        kiosk_mode: this.shadowRoot.querySelector("#mkmode").value,
        kiosk_duration_seconds: Number(this.shadowRoot.querySelector("#mkduration").value),
        kiosk_wake: this.shadowRoot.querySelector("#mkwake").checked,
        phone_options: {
          include_title_in_message: this.shadowRoot.querySelector("#mptitle").checked,
          show_actions: this.shadowRoot.querySelector("#mpactions").checked,
          sticky: this.shadowRoot.querySelector("#mpsticky").checked,
          persistent_on_phone: this.shadowRoot.querySelector("#mppersistent").checked,
          subtitle: this.shadowRoot.querySelector("#mpsubtitle").value,
          subject: this.shadowRoot.querySelector("#mpsubject").value,
          channel: this.shadowRoot.querySelector("#mpchannel").value,
          importance: this.shadowRoot.querySelector("#mpimportance").value,
          vibration_pattern: this.shadowRoot.querySelector("#mpvibration").value,
          led_color: this.shadowRoot.querySelector("#mpled").value,
          timeout: Number(this.shadowRoot.querySelector("#mptimeout").value),
          image: this.shadowRoot.querySelector("#mpimage").value,
          open_url: this.shadowRoot.querySelector("#mpurl").value,
        },
      };
      if (!body.title || !body.message) {
        this._toast("Uzupełnij tytuł i treść.", true);
        return;
      }
      if (!recipients.length && !body.kiosk_enabled) {
        this._toast("Wybierz odbiorcę telefonu albo włącz panel kiosku.", true);
        return;
      }
      await this._api("POST", "manual", body);
      await this._load(false);
      this._toast("Wysłano.");
    });
  }

  _bindSettings() {
    this.shadowRoot.querySelector("[data-add-user]")?.addEventListener("click", () => {
      this._captureSettingsForm();
      this._settingsDraft.users.push({
        key: this._uid(),
        name: "Nowy użytkownik",
        service: "",
        enabled: true,
        admin: false,
        ha_user_id: "",
      });
      this._queueRender();
    });
    this.shadowRoot.querySelectorAll("[data-remove-user]").forEach((button) => {
      button.onclick = () => {
        if (this._settingsDraft.users.length <= 1) return;
        this._captureSettingsForm();
        this._settingsDraft.users.splice(Number(button.dataset.removeUser), 1);
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-use-current]").forEach((button) => {
      button.onclick = () => {
        this._captureSettingsForm();
        const index = Number(button.dataset.useCurrent);
        this._settingsDraft.users[index].ha_user_id = this._state.current_user?.id || "";
        this._queueRender();
      };
    });
    this.shadowRoot.querySelectorAll("[data-test-user]").forEach((button) => {
      button.onclick = async () => {
        this._captureSettingsForm();
        const user = this._settingsDraft.users[Number(button.dataset.testUser)];
        const result = await this._api("POST", "test_service", {
          name: user.name,
          service: user.service,
        });
        this._toast(result.success ? `Wysłano test: ${user.name}` : "Brak lub błędna usługa notify", !result.success);
      };
    });
    this.shadowRoot.querySelector("[data-test-service]")?.addEventListener("click", async () => {
      this._captureSettingsForm();
      const result = await this._api("POST", "test_service", {
        name: "Signal",
        service: this._settingsDraft.signal_service,
      });
      this._toast(result.success ? "Wysłano test Signal" : "Brak usługi Signal", !result.success);
    });
    this.shadowRoot.querySelector("[data-savesettings]")?.addEventListener("click", async () => {
      this._captureSettingsForm();
      const names = this._settingsDraft.users.map((user) => user.name.trim());
      if (names.some((name) => !name)) {
        this._toast("Każdy użytkownik musi mieć nazwę.", true);
        return;
      }
      if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
        this._toast("Nazwy użytkowników nie mogą się powtarzać.", true);
        return;
      }
      if (this._settingsDraft.users.some((user) => !user.service.trim())) {
        this._toast("Każdy użytkownik musi mieć usługę notify.", true);
        return;
      }
      const recipients = {};
      this._settingsDraft.users.forEach((user) => {
        recipients[user.name.trim()] = {
          service: user.service.trim(),
          enabled: user.enabled,
          admin: user.admin,
          ha_user_id: user.ha_user_id,
        };
      });
      const body = {
        enabled: this._settingsDraft.enabled,
        persistent: this._settingsDraft.persistent,
        signal_enabled: this._settingsDraft.signal_enabled,
        quiet_enabled: this._settingsDraft.quiet_enabled,
        quiet_start: this._settingsDraft.quiet_start,
        quiet_end: this._settingsDraft.quiet_end,
        signal_service: this._settingsDraft.signal_service,
        kiosk_enabled: this._settingsDraft.kiosk_enabled,
        kiosk_min_level: this._settingsDraft.kiosk_min_level,
        kiosk_info_duration: this._settingsDraft.kiosk_info_duration,
        kiosk_task_duration: this._settingsDraft.kiosk_task_duration,
        kiosk_warning_duration: this._settingsDraft.kiosk_warning_duration,
        kiosk_wake_enabled: this._settingsDraft.kiosk_wake_enabled,
        kiosk_wake_entity: this._settingsDraft.kiosk_wake_entity,
        recipients,
      };
      await this._api("POST", "settings", body);
      this._settingsDraft = null;
      await this._load(false);
      this._toast("Ustawienia i użytkownicy zapisani.");
    });
  }

  _bindDiagnostics() {
    this.shadowRoot.querySelector("[data-eval]")?.addEventListener("click", async () => {
      await this._api("POST", "evaluate", {});
      await this._load(false);
      this._toast("Sprawdzono reguły.");
    });
  }

  _toast(message, error = false) {
    const toast = this.shadowRoot.querySelector("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${error ? "err" : ""}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (toast.className = "toast"), 4200);
  }

  _css() {
    return `
      :host{display:block;min-height:100%;color:#f4fdff;--c:#20eaff;--p:rgba(2,18,39,.9);--line:rgba(70,220,255,.35);--muted:rgba(170,225,246,.75);--red:#ff315c;--orange:#ff9f1c;--green:#35ff9a}
      *{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer}.shell{min-height:100vh;background:radial-gradient(circle at 15% 0,rgba(0,180,255,.18),transparent 30%),radial-gradient(circle at 85% 5%,rgba(32,234,255,.11),transparent 25%),linear-gradient(#00101f,#00040c);position:relative}.shell:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(32,234,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(32,234,255,.03) 1px,transparent 1px);background-size:32px 32px}.top{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;align-items:center;gap:20px;padding:14px 3vw;background:rgba(0,7,18,.9);border-bottom:1px solid rgba(32,234,255,.25);backdrop-filter:blur(16px)}.brand{display:flex;align-items:center;gap:13px}.brand>div:last-child{display:grid;gap:3px}.brand small{color:var(--c);font-size:10px;letter-spacing:1.3px}.logo{width:47px;height:47px;border-radius:15px;display:grid;place-items:center;background:var(--c);color:#001219;font-size:25px;font-weight:950;box-shadow:0 0 24px rgba(32,234,255,.5)}.stats{display:flex;gap:7px;align-items:center}.stats span{padding:7px 9px;border:1px solid var(--line);border-radius:12px;color:var(--muted);font-size:9px}.stats span b{color:var(--c);font-size:17px;margin-left:8px}.stats .red{color:var(--red)}.stats button{width:38px;height:38px;border-radius:12px;border:1px solid var(--line);background:#002238;color:var(--c);font-size:20px}nav{position:sticky;top:75px;z-index:19;display:flex;gap:4px;overflow:auto;padding:0 3vw;background:rgba(0,9,22,.9);border-bottom:1px solid rgba(32,234,255,.14)}nav button{flex:0 0 auto;padding:13px 14px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);font-weight:800}nav button.on{color:#fff;border-color:var(--c);background:linear-gradient(transparent,rgba(32,234,255,.08))}main{position:relative;z-index:2;max-width:1600px;margin:auto;padding:26px 3vw 100px}h1,h2,h3,p{margin-top:0}.head{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:22px}.head small,.panel h3,.preview-v2 h3{display:block;color:var(--c);font-size:11px;letter-spacing:1.3px}.head h1{margin:5px 0 0;font-size:clamp(27px,3vw,42px)}.count{width:50px;height:50px;border-radius:16px;display:grid;place-items:center;border:1px solid var(--line);color:var(--c);font-size:22px}.hero{display:flex;align-items:center;gap:20px;padding:25px;border:1px solid rgba(53,255,154,.45);border-radius:25px;background:radial-gradient(circle at 0 0,rgba(53,255,154,.14),transparent 42%),var(--p)}.hero p,.empty p,.nbody p,.rule>p,.tl p{color:var(--muted)}.check{width:66px;height:66px;border-radius:50%;display:grid;place-items:center;background:var(--green);color:#00180d;font-size:34px;font-weight:950}.empty{min-height:340px;display:grid;place-items:center;align-content:center;text-align:center;color:var(--muted)}.radar{width:125px;height:125px;border-radius:50%;border:1px solid rgba(32,234,255,.45);background:radial-gradient(circle,transparent 22%,rgba(32,234,255,.13) 23%,transparent 24%,transparent 46%,rgba(32,234,255,.13) 47%,transparent 48%),conic-gradient(rgba(32,234,255,.65),transparent 20%);animation:spin 4s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.list{display:grid;gap:13px}.notice{position:relative;display:grid;grid-template-columns:54px 1fr auto;gap:16px;align-items:center;padding:19px 19px 19px 24px;border:1px solid var(--line);border-radius:22px;background:var(--p);overflow:hidden}.notice>i{position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--c);box-shadow:0 0 14px var(--c)}.notice.critical{border-color:rgba(255,49,92,.55)}.notice.critical>i{background:var(--red)}.notice.warning>i{background:var(--orange)}.notice.task>i{background:var(--green)}.nicon{font-size:27px}.meta{display:flex;gap:9px;flex-wrap:wrap;color:rgba(170,220,240,.6);font-size:11px}.meta span,.badge{padding:4px 7px;border:1px solid rgba(32,234,255,.3);border-radius:999px;color:var(--c);font-weight:850}.nbody h2{margin:8px 0 6px}.nbody p{white-space:pre-line}.matched-summary{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.matched-summary>span{width:100%;color:var(--c);font-size:9px;font-weight:900;letter-spacing:.9px}.matched-summary>b{padding:5px 8px;border-radius:999px;border:1px solid rgba(53,255,154,.28);background:rgba(53,255,154,.07);color:#a7ffd2;font-size:10px}.matched-help{padding:8px 10px;border-left:3px solid rgba(53,255,154,.55);background:rgba(53,255,154,.05);border-radius:0 9px 9px 0}.nbody code{padding:5px 8px;background:rgba(0,0,0,.25);border-radius:9px;color:var(--muted)}.nbody code b{color:var(--c)}.actions{display:grid;gap:7px;min-width:135px}.actions button,.cardacts button,.recipient button,.head button,.editor-actionbar button{padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:#002238;color:#dff;font-weight:800}.primary{background:var(--c)!important;color:#001219!important;border-color:var(--c)!important}.timeline{display:grid;gap:12px}.tl{display:grid;grid-template-columns:20px 1fr;gap:12px}.tl>i{width:10px;height:10px;border-radius:50%;margin-top:18px;background:var(--c)}.tl>i.critical{background:var(--red)}.tl>i.warning{background:var(--orange)}.tl>i.task{background:var(--green)}.tl>div{padding:14px 16px;border:1px solid rgba(70,180,255,.25);border-radius:16px;background:rgba(1,15,33,.78)}.tl span{display:flex;justify-content:space-between;color:var(--c);font-size:11px}.tl h3{margin:8px 0 4px}.tl small{color:rgba(170,220,238,.55)}.headtools{display:flex;gap:9px}.headtools input,.head-search,input,select,textarea{padding:10px 11px;border:1px solid rgba(70,180,255,.35);border-radius:11px;background:rgba(0,12,29,.84);color:#fff;outline:none}.headtools input,.head-search{width:min(320px,38vw)}input:focus,select:focus,textarea:focus{border-color:var(--c);box-shadow:0 0 0 2px rgba(32,234,255,.08)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:13px}.rule,.panel,.preview-v2{padding:18px;border:1px solid var(--line);border-radius:21px;background:radial-gradient(circle at 100% 0,rgba(32,234,255,.09),transparent 38%),var(--p)}.rtop{display:flex;justify-content:space-between}.rule h2{margin:14px 0 5px}.cond{padding:10px;border-radius:12px;background:rgba(0,0,0,.24);display:grid;gap:7px;overflow:hidden}.cond code{color:var(--c);overflow:hidden;text-overflow:ellipsis}.cond span{display:flex;justify-content:space-between;color:var(--muted)}.cond b{color:var(--c)}.tags{display:flex;gap:6px;flex-wrap:wrap}.tags span{padding:4px 7px;border-radius:999px;background:rgba(32,234,255,.07);color:var(--muted);font-size:10px}.cardacts{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:14px}.del{color:#ff829a!important}.switch{display:inline-flex}.switch input{display:none}.switch span{width:43px;height:24px;border-radius:999px;position:relative;background:rgba(130,160,177,.3);border:1px solid rgba(180,220,235,.22)}.switch span:after{content:"";position:absolute;width:18px;height:18px;top:2px;left:3px;border-radius:50%;background:#d8edf5;transition:.2s}.switch input:checked+span{background:rgba(32,234,255,.38);border-color:var(--c)}.switch input:checked+span:after{transform:translateX(18px);background:var(--c)}.form{display:grid;grid-template-columns:1fr 1fr;gap:12px}.form label{display:grid;gap:6px;color:var(--muted);font-size:12px}.full{grid-column:1/-1}.form textarea{min-height:125px;resize:vertical}.toggle{display:flex!important;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid rgba(70,180,255,.12)}.recips{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.recips label{padding:9px;border:1px solid rgba(70,180,255,.28);border-radius:11px;background:rgba(0,25,43,.55)}.wide{width:100%;margin-top:15px;padding:11px;border-radius:12px}.manual{max-width:900px}.setgrid{display:grid;grid-template-columns:1fr 1.2fr;gap:13px}.recipient{display:grid;grid-template-columns:110px 1fr auto auto;gap:8px;align-items:center;padding:9px 0;border-bottom:1px solid rgba(70,180,255,.12)}.recipient button{color:var(--c)}.save-settings{display:block;margin:14px 0 0 auto;padding:11px 20px;border-radius:12px}.diag{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin-bottom:13px}.diag>div{min-height:115px;padding:15px;border:1px solid rgba(70,180,255,.28);border-radius:17px;background:var(--p);display:grid;align-content:center;gap:5px}.diag>div>span{font-size:24px}.diag small{color:var(--muted)}.diag b{color:var(--c);overflow-wrap:anywhere}.service{display:flex;justify-content:space-between;padding:9px;background:rgba(0,26,45,.5);border-radius:10px}.service .ok{color:var(--green)}.service .bad{color:var(--red)}.overlay{position:fixed;z-index:100;inset:0;display:grid;place-items:center;background:rgba(0,5,15,.4)}.loader{width:44px;height:44px;border-radius:50%;border:3px solid rgba(32,234,255,.18);border-top-color:var(--c);animation:spin .8s linear infinite}.boot{min-height:100vh;display:grid;place-items:center;align-content:center;gap:15px;background:#000914;color:#fff}.toast{position:fixed;z-index:200;right:24px;bottom:24px;padding:13px 16px;border-radius:12px;border:1px solid rgba(53,255,154,.5);background:rgba(0,35,29,.96);transform:translateY(100px);opacity:0;transition:.2s}.toast.show{transform:none;opacity:1}.toast.err{background:rgba(60,4,22,.96);border-color:rgba(255,49,92,.6)}
      .history-tools{display:flex;align-items:center;justify-content:flex-end;gap:9px;min-width:0}
      .history-tools .head-search{min-width:260px}
      .history-clear-button{padding:10px 13px;border-radius:11px;border:1px solid rgba(255,49,92,.52);background:rgba(72,4,25,.62);color:#ff9caf;font-weight:900;white-space:nowrap}
      .history-clear-button:hover{border-color:#ff315c;background:rgba(116,5,38,.78);box-shadow:0 0 18px rgba(255,49,92,.18)}
      .phone-options{border:1px solid rgba(32,234,255,.22);border-radius:14px;background:rgba(0,15,31,.48);padding:11px}.phone-options summary{cursor:pointer;color:var(--c);font-weight:900;letter-spacing:.7px}.phone-options>small{display:block;margin-top:10px;color:var(--muted);line-height:1.4}.phone-options-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}.phone-options-grid>label{display:grid;gap:5px;color:var(--muted);font-size:10px;min-width:0}.phone-options-grid .phone-check{display:flex;align-items:center;gap:7px;padding:9px;border:1px solid rgba(32,234,255,.14);border-radius:10px}.phone em,.phone>b{display:block;color:var(--muted);font-size:11px;margin-top:7px}.phone .hidden{display:none!important}.test-phone-box{display:grid;gap:8px;margin-top:12px;padding:11px;border:1px solid rgba(53,255,154,.25);border-radius:13px;background:rgba(3,54,37,.22)}.test-phone-box label{display:grid;gap:5px;color:var(--muted);font-size:10px}.test-phone-box button{width:100%}.users-panel{grid-column:1/-1}.settings-note,.current-user{color:var(--muted);line-height:1.45}.current-user code{color:var(--c)}.users-list{display:grid;gap:12px}.user-config{padding:13px;border:1px solid rgba(32,234,255,.22);border-radius:15px;background:rgba(0,13,29,.56)}.user-config-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;color:var(--c)}.user-config-grid{display:grid;grid-template-columns:1fr 1fr 1.2fr;gap:10px;align-items:end}.user-config-grid>label{display:grid;gap:5px;color:var(--muted);font-size:10px}.user-flags{display:flex;gap:12px;align-items:center;flex-wrap:wrap;color:var(--muted);font-size:10px}.user-actions{display:flex;gap:7px}.signal-test{display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding:11px;border:1px solid rgba(32,234,255,.18);border-radius:12px}.icon-danger:disabled{opacity:.35;cursor:not-allowed}
      .editor-layout-v2{display:grid;grid-template-columns:minmax(0,2.15fr) minmax(300px,.85fr);gap:16px;align-items:start}.editor-main-stack{display:grid;gap:16px;min-width:0}.preview-v2{position:sticky;top:140px;min-width:0}.panel-heading{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:14px}.panel-heading small{color:var(--c);font-size:10px;letter-spacing:1.2px}.panel-heading h2{margin:5px 0 0}.duplicate-toggle{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px}.rule-name-row{margin-bottom:12px}.logic-summary{display:grid;grid-template-columns:auto 1fr;gap:10px;padding:11px 13px;border-radius:13px;background:rgba(32,234,255,.07);border:1px solid rgba(32,234,255,.18);margin-bottom:12px;overflow:hidden}.logic-summary span{color:var(--c);font-size:10px;font-weight:900}.logic-summary b{color:var(--muted);font-size:12px;overflow-wrap:anywhere}.condition-group{margin-top:12px;padding:13px;border:1px solid rgba(32,234,255,.28);border-radius:16px;background:rgba(0,18,37,.62);min-width:0}.condition-group.depth-1{margin-left:12px;border-color:rgba(53,255,154,.3)}.condition-group.depth-2{margin-left:12px;border-color:rgba(255,159,28,.3)}.condition-group.depth-3{margin-left:12px;border-color:rgba(190,110,255,.3)}.condition-group.depth-4,.condition-group.depth-5{margin-left:12px;border-color:rgba(255,90,190,.28)}.condition-group.has-error,.condition-card.has-error{border-color:var(--red);box-shadow:0 0 0 1px rgba(255,49,92,.25),0 0 22px rgba(255,49,92,.08)}.group-head-v2{display:grid;grid-template-columns:minmax(180px,1fr) minmax(350px,1.4fr) auto;gap:10px;align-items:center;margin-bottom:11px}.group-identity{display:flex;align-items:center;gap:8px;min-width:0}.group-identity>div{display:grid;min-width:0}.group-identity small{color:var(--muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.drag-handle,.collapse-button,.node-tools button{width:32px;height:32px;border:1px solid rgba(32,234,255,.24);border-radius:9px;background:rgba(0,34,55,.7);color:var(--c);display:grid;place-items:center;padding:0}.drag-handle{cursor:grab}.group-controls{display:flex;gap:8px;align-items:center;justify-content:flex-end;min-width:0;flex-wrap:wrap}.group-controls select{min-width:190px;max-width:100%;padding:8px}.mini-check,.mini-duration,.threshold-control{display:flex;align-items:center;gap:5px;color:var(--muted);font-size:10px;white-space:nowrap}.mini-duration input,.threshold-control input{width:66px;padding:7px}.node-tools{display:flex;gap:5px;justify-content:flex-end}.icon-danger{color:#ff8ba2!important;border-color:rgba(255,49,92,.4)!important;background:rgba(70,4,24,.5)!important}.condition-items{display:grid;gap:10px}.group-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:11px}.group-actions button{padding:8px 11px;border-radius:10px;border:1px solid rgba(32,234,255,.3);background:#002238;color:#dff;font-weight:800}.group-empty,.collapsed-summary{padding:12px;color:var(--muted);text-align:center;border:1px dashed rgba(32,234,255,.2);border-radius:10px;overflow-wrap:anywhere}.condition-card{padding:11px;border:1px solid rgba(70,180,255,.2);border-radius:14px;background:rgba(0,7,18,.67);min-width:0}.condition-card.drag-over,.condition-group.drag-over{border-color:var(--green);box-shadow:0 0 20px rgba(53,255,154,.18)}.condition-card-head{display:grid;grid-template-columns:minmax(160px,1fr) auto auto;gap:9px;align-items:center;margin-bottom:10px}.condition-identity{display:flex;align-items:center;gap:8px;color:var(--c)}.condition-identity small{color:var(--muted)}.condition-head-options{display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:var(--muted);font-size:10px}.condition-head-options label{display:flex;align-items:center;gap:5px}.condition-head-options input[type=number]{width:65px;padding:6px}.condition-main-grid{display:grid;grid-template-columns:minmax(190px,1.4fr) minmax(145px,.7fr) minmax(170px,1fr);gap:9px;align-items:start}.condition-main-grid label,.entity-search-wrap{display:grid;gap:5px;color:var(--muted);font-size:11px;min-width:0}.span-2{grid-column:auto}.entity-search-wrap{position:relative}.entity-search-wrap small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.entity-search-wrap small b{color:var(--c)}.condition-results{position:absolute;z-index:60;top:64px;left:0;right:0;max-height:320px;overflow:auto;background:#001329;border:1px solid rgba(32,234,255,.5);border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.5)}.condition-results:empty{display:none}.condition-results button{width:100%;display:flex;justify-content:space-between;align-items:center;gap:8px;text-align:left;border:0;border-bottom:1px solid rgba(70,180,255,.13);padding:9px 10px;background:transparent;color:#fff}.condition-results button:hover{background:rgba(32,234,255,.08)}.condition-results button span{display:grid;min-width:0}.condition-results code{color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.condition-results strong{color:var(--c)}.condition-results p{padding:10px;color:var(--muted)}.operator-note{padding:11px;border:1px dashed rgba(32,234,255,.24);border-radius:10px;color:var(--muted)}.mini-chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;max-width:100%;overflow:visible}.mini-chips button{padding:5px 8px;border-radius:999px;border:1px solid rgba(32,234,255,.25);background:#002238;color:#cff;font-size:10px;white-space:normal;overflow-wrap:anywhere}.mini-chips button.on,.mini-chips button:hover{background:var(--c);color:#001219}.condition-advanced{margin-top:9px;border-top:1px solid rgba(70,180,255,.12);padding-top:8px}.condition-advanced summary{color:var(--muted);font-size:10px;cursor:pointer}.advanced-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:9px}.advanced-grid label{display:grid;gap:5px;color:var(--muted);font-size:10px}.advanced-grid label:first-child{display:flex;align-items:center}.advanced-description{grid-column:1/-1}.advanced-description textarea{min-height:64px;resize:vertical}.advanced-resolved-toggle{grid-column:1/-1!important;display:flex!important;align-items:center!important;gap:7px}.resolved-level-select{grid-column:1/-1;max-width:430px}.resolved-level-select select:disabled{opacity:.55;cursor:not-allowed}.resolved-confirm-toggle{margin-left:24px;color:var(--c)!important}.resolved-confirm-toggle input:disabled+span{opacity:.5}.advanced-description-help{grid-column:1/-1;color:var(--muted);line-height:1.45}.time-grid-v2{display:grid;grid-template-columns:150px 150px 1fr;gap:10px;align-items:end}.time-grid-v2>label{display:grid;gap:5px;color:var(--muted);font-size:11px}.weekday-chips{display:flex;gap:5px;flex-wrap:wrap}.weekday-chips label{display:block}.weekday-chips input{display:none}.weekday-chips span{display:grid;place-items:center;width:31px;height:31px;border-radius:8px;border:1px solid rgba(32,234,255,.25);color:var(--muted)}.weekday-chips input:checked+span{background:var(--c);color:#001219}.duration-field{display:grid;gap:6px;margin-top:14px;color:var(--muted);font-size:12px}.notification-panel{overflow:visible}.notification-form{align-items:start}.template-help{color:var(--muted);line-height:1.5}.preview-v2 .logic-preview{display:flex;justify-content:space-between;padding:9px;margin-bottom:10px;border-radius:11px;background:rgba(32,234,255,.07);color:var(--c)}.phone{min-height:330px;border-radius:26px;padding:25px 18px;background:linear-gradient(165deg,#061522,#00040a);border:1px solid rgba(160,220,240,.25);position:relative}.phone>small{color:var(--c)}.phone h3{margin-top:20px}.phone p{color:var(--muted);white-space:pre-line;overflow-wrap:anywhere}.phone>div{position:absolute;left:18px;right:18px;bottom:18px;display:grid;grid-template-columns:1fr 1fr;gap:6px}.phone>div.hidden{display:none}.phone>div span{padding:7px;text-align:center;border:1px solid rgba(32,234,255,.3);border-radius:9px;color:var(--c);font-size:10px}.preview-routing{margin-top:10px;padding:9px;border-radius:10px;background:rgba(32,234,255,.06);color:var(--muted);font-size:10px}.test-result{margin-top:12px;padding:11px;border-radius:12px;border:1px solid rgba(255,49,92,.4);background:rgba(65,5,23,.38)}.test-result.passed{border-color:rgba(53,255,154,.4);background:rgba(3,65,39,.28)}.test-result>div{display:grid;gap:4px}.test-result span{color:var(--muted);font-size:10px}.test-result ul{list-style:none;padding:0;margin:9px 0 0;display:grid;gap:5px;max-height:240px;overflow:auto}.test-result li{display:flex;gap:6px;font-size:10px;color:var(--muted)}.test-result li.ok>span{color:var(--green)}.test-result li.bad>span{color:var(--red)}.editor-actionbar{position:sticky;z-index:18;bottom:12px;margin-top:16px;padding:12px 14px;border:1px solid rgba(32,234,255,.38);border-radius:16px;background:rgba(0,9,22,.92);backdrop-filter:blur(16px);display:flex;justify-content:space-between;align-items:center;gap:14px;box-shadow:0 12px 45px rgba(0,0,0,.35)}.editor-actionbar>div:first-child{display:grid}.editor-actionbar>div:first-child b{color:var(--c);font-size:10px}.editor-actionbar>div:first-child span{color:var(--muted);font-size:10px}.editor-actionbar>div:last-child{display:flex;gap:8px}
      @media(max-width:1180px){.editor-layout-v2{grid-template-columns:minmax(0,1.65fr) minmax(280px,.75fr)}.group-head-v2{grid-template-columns:1fr}.group-controls{justify-content:flex-start}.node-tools{justify-content:flex-start}.condition-main-grid{grid-template-columns:1fr 1fr}.condition-main-grid .span-2{grid-column:1/-1}.time-grid-v2{grid-template-columns:1fr 1fr}.weekday-chips{grid-column:1/-1}.advanced-grid{grid-template-columns:1fr 1fr}}
      @media(max-width:900px){.editor-layout-v2{grid-template-columns:1fr}.preview-v2{position:static}.condition-group.depth-1,.condition-group.depth-2,.condition-group.depth-3,.condition-group.depth-4,.condition-group.depth-5{margin-left:5px}.condition-card-head{grid-template-columns:1fr}.node-tools{justify-content:flex-start}.condition-main-grid{grid-template-columns:1fr}.condition-main-grid .span-2{grid-column:auto}.time-grid-v2{grid-template-columns:1fr}.advanced-grid{grid-template-columns:1fr}.panel-heading{flex-direction:column}.editor-actionbar{bottom:6px}}
      @media(max-width:720px){.stats span{display:none}.brand small{display:none}.head{align-items:stretch;flex-direction:column}.headtools{flex-direction:column}.headtools input,.head-search{width:100%}.history-tools{width:100%;flex-direction:column;align-items:stretch}.history-tools .head-search{min-width:0}.history-clear-button{width:100%}.notice{grid-template-columns:40px 1fr}.actions{grid-column:1/-1;grid-template-columns:repeat(3,1fr)}.diag{grid-template-columns:1fr 1fr}.recips{grid-template-columns:1fr}.form{grid-template-columns:1fr}.full{grid-column:auto}.setgrid{grid-template-columns:1fr}.recipient{grid-template-columns:1fr auto}.recipient input{grid-column:1/-1}.group-controls{display:grid;grid-template-columns:1fr 1fr}.group-controls select{grid-column:1/-1}.editor-actionbar{align-items:stretch;flex-direction:column}.editor-actionbar>div:last-child{display:grid;grid-template-columns:1fr 1fr}.cardacts{grid-template-columns:1fr}.notification-panel .toggle{grid-column:auto}.phone-options-grid{grid-template-columns:1fr}.user-config-grid{grid-template-columns:1fr}.user-actions{display:grid;grid-template-columns:1fr 1fr}}
    `;
  }
}

if (!customElements.get("matrix-notification-center-panel")) {
  customElements.define("matrix-notification-center-panel", MatrixNotificationCenterPanel);
}
