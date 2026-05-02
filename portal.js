const state = {
  config: {
    services: [],
    locations: [],
    whatsappConfigured: false,
    whatsappProvider: "none",
  },
  user: null,
  selectedSlotId: null,
  selectedSlotLabel: "",
  clientSlots: [],
  clientAppointments: [],
  adminSlots: [],
  adminAppointments: [],
  pollTimer: null,
};

const elements = {
  authSection: document.getElementById("auth-section"),
  authTabs: [...document.querySelectorAll(".auth-tab")],
  loginForm: document.getElementById("login-form"),
  registerForm: document.getElementById("register-form"),
  authFeedback: document.getElementById("auth-feedback"),
  adminHint: document.getElementById("admin-hint"),
  logoutButton: document.getElementById("logout-button"),
  clientDashboard: document.getElementById("client-dashboard"),
  adminDashboard: document.getElementById("admin-dashboard"),
  clientGreeting: document.getElementById("client-greeting"),
  adminGreeting: document.getElementById("admin-greeting"),
  clientSlotGroups: document.getElementById("client-slot-groups"),
  availableSlotCount: document.getElementById("available-slot-count"),
  selectedSlotBox: document.getElementById("selected-slot-box"),
  clientBookingForm: document.getElementById("client-booking-form"),
  bookingFeedback: document.getElementById("client-booking-feedback"),
  clientAppointments: document.getElementById("client-appointments"),
  clientServiceSelect: document.getElementById("client-service-select"),
  clientLocationSelect: document.getElementById("client-location-select"),
  clientPhoneInput: document.getElementById("client-phone-input"),
  refreshClientData: document.getElementById("refresh-client-data"),
  refreshAdminData: document.getElementById("refresh-admin-data"),
  adminStats: document.getElementById("admin-stats"),
  slotCreateForm: document.getElementById("slot-create-form"),
  slotCreateFeedback: document.getElementById("slot-create-feedback"),
  adminSlotsTable: document.getElementById("admin-slots-table"),
  adminAppointmentsTable: document.getElementById("admin-appointments-table"),
};

const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-").map(Number);
  return dateFormatter.format(new Date(year, month - 1, day));
}

function formatDateTime(dateValue, timeValue) {
  return `${formatDate(dateValue)} a ${timeValue}`;
}

function resetFeedback(element) {
  element.textContent = "";
  element.classList.add("is-hidden");
}

function showFeedback(element, message, type = "error") {
  element.textContent = message;
  element.classList.remove("is-hidden");
  element.style.background = type === "success" ? "#eef9f2" : "#fff2f2";
  element.style.borderColor = type === "success" ? "rgba(25, 125, 87, 0.2)" : "rgba(191, 71, 71, 0.18)";
  element.style.color = type === "success" ? "#197d57" : "#bf4747";
}

async function api(path, options = {}) {
  const request = {
    credentials: "same-origin",
    headers: {},
    ...options,
  };

  if (options.body && !(options.body instanceof FormData)) {
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, request);
  const data = await response.json().catch(() => ({ ok: false, error: "Reponse invalide du serveur." }));

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "Une erreur est survenue.");
  }

  return data;
}

function renderOptionList(select, options, placeholder) {
  select.innerHTML = "";
  if (placeholder) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    select.appendChild(empty);
  }

  options.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

function setAuthView(view) {
  const isLogin = view === "login";
  elements.authTabs.forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.authView === view);
  });
  elements.loginForm.classList.toggle("is-hidden", !isLogin);
  elements.registerForm.classList.toggle("is-hidden", isLogin);
  resetFeedback(elements.authFeedback);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  if (!state.user) return;

  const refresh = state.user.role === "admin" ? refreshAdminData : refreshClientData;
  state.pollTimer = window.setInterval(() => {
    refresh().catch(() => {});
  }, 30000);
}

function setSelectedSlot(slotId) {
  state.selectedSlotId = slotId;
  const slot = state.clientSlots.find((entry) => entry.id === slotId);
  state.selectedSlotLabel = slot ? formatDateTime(slot.date, slot.time) : "";
  elements.selectedSlotBox.textContent = slot
    ? `Creneau selectionne: ${state.selectedSlotLabel}`
    : "Aucun creneau selectionne.";

  [...elements.clientSlotGroups.querySelectorAll(".slot-button")].forEach((button) => {
    button.classList.toggle("is-selected", Number(button.dataset.slotId) === slotId);
  });
}

function renderClientSlots() {
  const available = state.clientSlots.filter((slot) => slot.status === "available");
  elements.availableSlotCount.textContent = `${available.length} disponible${available.length > 1 ? "s" : ""}`;

  if (!available.length) {
    elements.clientSlotGroups.innerHTML = `
      <div class="slot-group">
        <h4>Aucun creneau disponible</h4>
        <p>Les prochaines disponibilites apparaitront ici des qu'elles seront ouvertes.</p>
      </div>
    `;
    setSelectedSlot(null);
    return;
  }

  const grouped = new Map();
  available.forEach((slot) => {
    if (!grouped.has(slot.date)) {
      grouped.set(slot.date, []);
    }
    grouped.get(slot.date).push(slot);
  });

  elements.clientSlotGroups.innerHTML = [...grouped.entries()]
    .map(
      ([dateValue, slots]) => `
        <article class="slot-group">
          <h4>${escapeHtml(formatDate(dateValue))}</h4>
          <div class="slot-buttons">
            ${slots
              .map(
                (slot) => `
                  <button class="slot-button${state.selectedSlotId === slot.id ? " is-selected" : ""}" type="button" data-slot-id="${slot.id}">
                    ${escapeHtml(slot.time)}
                  </button>
                `
              )
              .join("")}
          </div>
        </article>
      `
    )
    .join("");

  if (!available.some((slot) => slot.id === state.selectedSlotId)) {
    setSelectedSlot(available[0].id);
  } else {
    setSelectedSlot(state.selectedSlotId);
  }
}

function renderClientAppointments() {
  if (!state.clientAppointments.length) {
    elements.clientAppointments.innerHTML = `
      <div class="appointment-item">
        <h4>Aucun rendez-vous pour le moment</h4>
        <p>Vos confirmations apparaitront ici apres reservation.</p>
      </div>
    `;
    return;
  }

  elements.clientAppointments.innerHTML = state.clientAppointments
    .map(
      (appointment) => `
        <article class="appointment-item">
          <div class="card-header">
            <div>
              <h4>${escapeHtml(appointment.service)}</h4>
              <p>${escapeHtml(formatDateTime(appointment.date, appointment.time))}</p>
            </div>
            <span class="status-pill ${appointment.status}">${escapeHtml(appointment.status)}</span>
          </div>
          <p>Lieu: ${escapeHtml(appointment.location)}</p>
          <p>WhatsApp: ${escapeHtml(appointment.phone)}</p>
          <p>Notification WhatsApp: ${escapeHtml(appointment.whatsapp_status || "pending")}</p>
          ${appointment.notes ? `<p>Notes: ${escapeHtml(appointment.notes)}</p>` : ""}
          ${
            appointment.status === "confirmed"
              ? `
                <div class="appointment-actions">
                  <button class="mini-button danger" type="button" data-cancel-appointment="${appointment.id}">
                    Annuler
                  </button>
                </div>
              `
              : ""
          }
        </article>
      `
    )
    .join("");
}

function renderAdminStats() {
  const totalSlots = state.adminSlots.length;
  const availableSlots = state.adminSlots.filter((slot) => slot.status === "available").length;
  const bookedSlots = state.adminSlots.filter((slot) => slot.status === "booked").length;
  const confirmedAppointments = state.adminAppointments.filter(
    (appointment) => appointment.status === "confirmed"
  ).length;

  elements.adminStats.innerHTML = `
    <article>
      <span>Creneaux au total</span>
      <strong>${totalSlots}</strong>
    </article>
    <article>
      <span>Disponibles</span>
      <strong>${availableSlots}</strong>
    </article>
    <article>
      <span>Reserves</span>
      <strong>${bookedSlots}</strong>
    </article>
    <article>
      <span>Rendez-vous confirmes</span>
      <strong>${confirmedAppointments}</strong>
    </article>
  `;
}

function renderAdminSlots() {
  if (!state.adminSlots.length) {
    elements.adminSlotsTable.innerHTML = `
      <tr>
        <td colspan="5">Aucun creneau cree pour le moment.</td>
      </tr>
    `;
    return;
  }

  elements.adminSlotsTable.innerHTML = state.adminSlots
    .map(
      (slot) => `
        <tr data-slot-row="${slot.id}">
          <td>
            <input class="table-input" type="date" data-field="date" value="${escapeHtml(slot.date)}" ${
              slot.status === "booked" ? "disabled" : ""
            } />
          </td>
          <td>
            <input class="table-input" type="time" data-field="time" value="${escapeHtml(slot.time)}" ${
              slot.status === "booked" ? "disabled" : ""
            } />
          </td>
          <td>
            <span class="status-pill ${slot.status === "available" ? "confirmed" : "cancelled"}">
              ${escapeHtml(slot.status)}
            </span>
          </td>
          <td>
            <input class="table-input" type="text" data-field="note" value="${escapeHtml(slot.note || "")}" ${
              slot.status === "booked" ? "disabled" : ""
            } />
          </td>
          <td>
            <div class="small-actions">
              <button class="mini-button primary" type="button" data-slot-action="save" data-slot-id="${slot.id}" ${
                slot.status === "booked" ? "disabled" : ""
              }>
                Enregistrer
              </button>
              <button class="mini-button danger" type="button" data-slot-action="delete" data-slot-id="${slot.id}" ${
                slot.status === "booked" ? "disabled" : ""
              }>
                Supprimer
              </button>
            </div>
          </td>
        </tr>
      `
    )
    .join("");
}

function buildSelectOptions(values, selectedValue, allowEmptyLabel = "") {
  const options = [];
  if (allowEmptyLabel) {
    options.push(`<option value="">${escapeHtml(allowEmptyLabel)}</option>`);
  }

  values.forEach((value) => {
    options.push(
      `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(value)}</option>`
    );
  });

  return options.join("");
}

function renderAdminAppointments() {
  if (!state.adminAppointments.length) {
    elements.adminAppointmentsTable.innerHTML = `
      <tr>
        <td colspan="9">Aucun rendez-vous enregistre pour le moment.</td>
      </tr>
    `;
    return;
  }

  const availableSlots = state.adminSlots.filter((slot) => slot.status === "available");

  elements.adminAppointmentsTable.innerHTML = state.adminAppointments
    .map((appointment) => {
      const slotOptions = buildSelectOptions(
        availableSlots.map((slot) => `${slot.id}__${formatDateTime(slot.date, slot.time)}`),
        "",
        "Choisir un creneau"
      )
        .replace(/ value="(\d+)__([^"]+)"/g, ' value="$1"')
        .replace(/>([^<]+)__/g, ">");

      return `
        <tr data-appointment-row="${appointment.id}">
          <td>${escapeHtml(appointment.client_name || "-")}</td>
          <td>${escapeHtml(appointment.client_email || "")}<br />${escapeHtml(appointment.phone || "")}</td>
          <td>${escapeHtml(formatDate(appointment.date))}</td>
          <td>${escapeHtml(appointment.time)}</td>
          <td>
            <select class="table-select" data-field="service" ${appointment.status !== "confirmed" ? "disabled" : ""}>
              ${buildSelectOptions(state.config.services, appointment.service)}
            </select>
          </td>
          <td>
            <select class="table-select" data-field="location" ${appointment.status !== "confirmed" ? "disabled" : ""}>
              ${buildSelectOptions(state.config.locations, appointment.location)}
            </select>
          </td>
          <td>
            <span class="status-pill ${appointment.status}">${escapeHtml(appointment.status)}</span>
            <div>${escapeHtml(appointment.whatsapp_status || "pending")}</div>
            <input
              class="table-input"
              type="text"
              data-field="notes"
              value="${escapeHtml(appointment.notes || "")}"
              placeholder="Notes"
              ${appointment.status !== "confirmed" ? "disabled" : ""}
            />
          </td>
          <td>
            <select class="table-select" data-field="slotId" ${appointment.status !== "confirmed" ? "disabled" : ""}>
              ${slotOptions}
            </select>
          </td>
          <td>
            <div class="small-actions">
              <button class="mini-button primary" type="button" data-appointment-action="save" data-appointment-id="${appointment.id}" ${
                appointment.status !== "confirmed" ? "disabled" : ""
              }>
                Enregistrer
              </button>
              <button class="mini-button warn" type="button" data-appointment-action="reschedule" data-appointment-id="${appointment.id}" ${
                appointment.status !== "confirmed" ? "disabled" : ""
              }>
                Reprogrammer
              </button>
              <button class="mini-button danger" type="button" data-appointment-action="cancel" data-appointment-id="${appointment.id}" ${
                appointment.status !== "confirmed" ? "disabled" : ""
              }>
                Annuler
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function applyUserVisibility() {
  const user = state.user;
  const isClient = user?.role === "client";
  const isAdmin = user?.role === "admin";

  elements.authSection.classList.toggle("is-hidden", Boolean(user));
  elements.logoutButton.classList.toggle("is-hidden", !user);
  elements.clientDashboard.classList.toggle("is-hidden", !isClient);
  elements.adminDashboard.classList.toggle("is-hidden", !isAdmin);

  if (isClient) {
    elements.clientGreeting.textContent = `Bonjour ${user.name}`;
    elements.clientPhoneInput.value = user.phone || "";
  }

  if (isAdmin) {
    elements.adminGreeting.textContent = `Bonjour ${user.name}`;
  }
}

async function refreshClientData() {
  const [slotsResponse, appointmentsResponse] = await Promise.all([
    api("/api/slots"),
    api("/api/appointments"),
  ]);

  state.clientSlots = slotsResponse.slots || [];
  state.clientAppointments = appointmentsResponse.appointments || [];
  renderClientSlots();
  renderClientAppointments();
}

async function refreshAdminData() {
  const [slotsResponse, appointmentsResponse] = await Promise.all([
    api("/api/admin/slots"),
    api("/api/appointments"),
  ]);

  state.adminSlots = slotsResponse.slots || [];
  state.adminAppointments = appointmentsResponse.appointments || [];
  renderAdminStats();
  renderAdminSlots();
  renderAdminAppointments();
}

async function refreshSession() {
  const response = await api("/api/auth/me");
  state.user = response.user;
  applyUserVisibility();
  startPolling();

  if (!state.user) {
    stopPolling();
    return;
  }

  if (state.user.role === "client") {
    await refreshClientData();
    return;
  }

  if (state.user.role === "admin") {
    await refreshAdminData();
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  resetFeedback(elements.authFeedback);

  const formData = new FormData(elements.loginForm);

  try {
    const response = await api("/api/auth/login", {
      method: "POST",
      body: {
        email: formData.get("email"),
        password: formData.get("password"),
      },
    });

    state.user = response.user;
    elements.loginForm.reset();
    await refreshSession();
  } catch (error) {
    showFeedback(elements.authFeedback, error.message);
  }
}

async function handleRegisterSubmit(event) {
  event.preventDefault();
  resetFeedback(elements.authFeedback);

  const formData = new FormData(elements.registerForm);

  try {
    const response = await api("/api/auth/register", {
      method: "POST",
      body: {
        name: formData.get("name"),
        email: formData.get("email"),
        phone: formData.get("phone"),
        password: formData.get("password"),
      },
    });

    state.user = response.user;
    elements.registerForm.reset();
    await refreshSession();
  } catch (error) {
    showFeedback(elements.authFeedback, error.message);
  }
}

async function handleLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    console.error(error);
  }

  state.user = null;
  state.selectedSlotId = null;
  state.selectedSlotLabel = "";
  state.clientSlots = [];
  state.clientAppointments = [];
  state.adminSlots = [];
  state.adminAppointments = [];
  stopPolling();
  applyUserVisibility();
  setAuthView("login");
}

async function handleBookingSubmit(event) {
  event.preventDefault();
  resetFeedback(elements.bookingFeedback);

  if (!state.selectedSlotId) {
    showFeedback(elements.bookingFeedback, "Veuillez d'abord selectionner un creneau.");
    return;
  }

  const formData = new FormData(elements.clientBookingForm);

  try {
    await api("/api/appointments", {
      method: "POST",
      body: {
        slotId: state.selectedSlotId,
        service: formData.get("service"),
        location: formData.get("location"),
        phone: formData.get("phone"),
        notes: formData.get("notes"),
      },
    });

    showFeedback(elements.bookingFeedback, "Rendez-vous confirme avec succes.", "success");
    state.selectedSlotId = null;
    await refreshClientData();
  } catch (error) {
    showFeedback(elements.bookingFeedback, error.message);
  }
}

async function handleClientAppointmentActions(event) {
  const button = event.target.closest("[data-cancel-appointment]");
  if (!button) return;

  try {
    await api(`/api/appointments/${button.dataset.cancelAppointment}/cancel`, {
      method: "PATCH",
    });
    await refreshClientData();
  } catch (error) {
    showFeedback(elements.bookingFeedback, error.message);
  }
}

async function handleCreateSlots(event) {
  event.preventDefault();
  resetFeedback(elements.slotCreateFeedback);

  const formData = new FormData(elements.slotCreateForm);
  const times = String(formData.get("times") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  try {
    const response = await api("/api/admin/slots", {
      method: "POST",
      body: {
        date: formData.get("date"),
        times,
        note: formData.get("note"),
      },
    });

    const duplicateNote = response.duplicates?.length
      ? ` Duplicates ignores: ${response.duplicates.join(", ")}.`
      : "";
    showFeedback(
      elements.slotCreateFeedback,
      `${response.created.length} creneau(x) ajoute(s).${duplicateNote}`,
      "success"
    );
    elements.slotCreateForm.reset();
    await refreshAdminData();
  } catch (error) {
    showFeedback(elements.slotCreateFeedback, error.message);
  }
}

async function handleAdminSlotActions(event) {
  const button = event.target.closest("[data-slot-action]");
  if (!button) return;

  const slotId = button.dataset.slotId;
  const row = event.target.closest(`[data-slot-row="${slotId}"]`);
  if (!row) return;

  try {
    if (button.dataset.slotAction === "save") {
      await api(`/api/admin/slots/${slotId}`, {
        method: "PATCH",
        body: {
          date: row.querySelector('[data-field="date"]').value,
          time: row.querySelector('[data-field="time"]').value,
          note: row.querySelector('[data-field="note"]').value,
        },
      });
    }

    if (button.dataset.slotAction === "delete") {
      await api(`/api/admin/slots/${slotId}`, {
        method: "DELETE",
      });
    }

    await refreshAdminData();
  } catch (error) {
    showFeedback(elements.slotCreateFeedback, error.message);
  }
}

async function handleAdminAppointmentActions(event) {
  const button = event.target.closest("[data-appointment-action]");
  if (!button) return;

  const appointmentId = button.dataset.appointmentId;
  const row = event.target.closest(`[data-appointment-row="${appointmentId}"]`);
  if (!row) return;

  const service = row.querySelector('[data-field="service"]').value;
  const location = row.querySelector('[data-field="location"]').value;
  const notes = row.querySelector('[data-field="notes"]').value;
  const slotId = row.querySelector('[data-field="slotId"]').value;

  try {
    if (button.dataset.appointmentAction === "save") {
      await api(`/api/admin/appointments/${appointmentId}/update`, {
        method: "PATCH",
        body: { service, location, notes },
      });
    }

    if (button.dataset.appointmentAction === "cancel") {
      await api(`/api/admin/appointments/${appointmentId}/cancel`, {
        method: "PATCH",
      });
    }

    if (button.dataset.appointmentAction === "reschedule") {
      if (!slotId) {
        throw new Error("Veuillez choisir un nouveau creneau pour reprogrammer.");
      }

      await api(`/api/admin/appointments/${appointmentId}/reschedule`, {
        method: "PATCH",
        body: { slotId: Number(slotId) },
      });
    }

    await refreshAdminData();
  } catch (error) {
    showFeedback(elements.slotCreateFeedback, error.message);
  }
}

async function boot() {
  setAuthView("login");
  resetFeedback(elements.bookingFeedback);
  resetFeedback(elements.slotCreateFeedback);

  elements.authTabs.forEach((tab) => {
    tab.addEventListener("click", () => setAuthView(tab.dataset.authView));
  });

  elements.loginForm.addEventListener("submit", handleLoginSubmit);
  elements.registerForm.addEventListener("submit", handleRegisterSubmit);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.clientBookingForm.addEventListener("submit", handleBookingSubmit);
  elements.clientSlotGroups.addEventListener("click", (event) => {
    const button = event.target.closest("[data-slot-id]");
    if (!button) return;
    setSelectedSlot(Number(button.dataset.slotId));
  });
  elements.clientAppointments.addEventListener("click", handleClientAppointmentActions);
  elements.slotCreateForm.addEventListener("submit", handleCreateSlots);
  elements.adminSlotsTable.addEventListener("click", handleAdminSlotActions);
  elements.adminAppointmentsTable.addEventListener("click", handleAdminAppointmentActions);
  elements.refreshClientData.addEventListener("click", () => {
    refreshClientData().catch((error) => showFeedback(elements.bookingFeedback, error.message));
  });
  elements.refreshAdminData.addEventListener("click", () => {
    refreshAdminData().catch((error) => showFeedback(elements.slotCreateFeedback, error.message));
  });

  try {
    const configResponse = await api("/api/config");
    state.config = {
      services: configResponse.services || [],
      locations: configResponse.locations || [],
      whatsappConfigured: Boolean(configResponse.whatsappConfigured),
      whatsappProvider: configResponse.whatsappProvider || "none",
    };
    renderOptionList(elements.clientServiceSelect, state.config.services);
    renderOptionList(elements.clientLocationSelect, state.config.locations);
    elements.adminHint.textContent = state.config.whatsappConfigured
      ? `Notifications WhatsApp actives via ${state.config.whatsappProvider === "meta" ? "Meta Cloud API" : "Twilio"}.`
      : "Notifications WhatsApp en mode preparation. Configurez de preference Meta Cloud API, ou Twilio en alternative.";
  } catch (error) {
    showFeedback(elements.authFeedback, error.message);
  }

  try {
    await refreshSession();
  } catch (error) {
    showFeedback(elements.authFeedback, error.message);
  }
}

document.addEventListener("DOMContentLoaded", boot);
