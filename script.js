const whatsappNumber = "351910221393";
const scheduleStorageKey = "studioEleganceScheduleConfig";
const ownerModeStorageKey = "studioEleganceOwnerMode";
const ownerAccessCode = "karol910";

const defaultAvailabilityByWeekday = {
  0: [],
  1: ["09:00", "10:30", "12:00", "14:00", "16:00"],
  2: ["09:30", "11:00", "13:30", "15:00", "17:00"],
  3: ["09:00", "10:30", "12:30", "15:30"],
  4: ["10:00", "11:30", "14:30", "17:00"],
  5: ["09:00", "10:30", "13:00", "15:00"],
  6: ["10:00", "12:30", "14:00"],
};

const workImages = [
  {
    file: "fotos trabalho/sas.jpeg",
    alt: "Shadow Effet naturel",
    label: "Shadow Effet naturel",
    description: "Un effet naturel qui dure jusqu'a 1 an.",
    contained: true,
  },
  ...[2, 6, 8, 9, 10, 14, 16, 17, 18].map((imageId, index) => ({
    file: `fotos trabalho/${imageId}.jpeg`,
    alt: `Photo du travail ${String(index + 2).padStart(2, "0")}`,
    label: `Photo ${String(index + 2).padStart(2, "0")}`,
    description: "Photo reelle du travail de la professionnelle.",
  })),
];

const catalogGrid = document.querySelector("#catalog-grid");
const galleryShell = document.querySelector("#gallery-shell");
const toggleGalleryButtons = document.querySelectorAll("#toggle-gallery, #toggle-gallery-secondary");
const calendarTitle = document.querySelector("#calendar-title");
const calendarGrid = document.querySelector("#calendar-grid");
const calendarPrevButton = document.querySelector("#calendar-prev");
const calendarNextButton = document.querySelector("#calendar-next");
const selectedDayTitle = document.querySelector("#selected-day-title");
const selectedDayMeta = document.querySelector("#selected-day-meta");
const daySlotsGrid = document.querySelector("#day-slots-grid");
const whatsappForm = document.querySelector("#whatsapp-form");
const bookingOutput = document.querySelector("#booking-output");
const whatsappLink = document.querySelector("#whatsapp-link");
const bookingDateInput = document.querySelector("#booking-date");
const bookingTimeInput = document.querySelector("#booking-time");
const selectedSlotText = document.querySelector("#selected-slot-text");
const bookingError = document.querySelector("#booking-error");
const weeklyConfigForm = document.querySelector("#weekly-config-form");
const dateOverrideForm = document.querySelector("#date-override-form");
const overrideDateInput = document.querySelector("#override-date");
const overrideAvailableInput = document.querySelector("#override-available");
const overrideBookedInput = document.querySelector("#override-booked");
const resetDateOverrideButton = document.querySelector("#reset-date-override");
const managerFeedback = document.querySelector("#manager-feedback");
const ownerNavLink = document.querySelector("#owner-nav-link");
const ownerSection = document.querySelector("#gestion-horaires");

const today = new Date();
let currentMonthDate = new Date(today.getFullYear(), today.getMonth(), 1);
let selectedCalendarDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
let selectedAgendaButton = null;
let scheduleConfig = loadScheduleConfig();
let ownerModeEnabled = loadOwnerMode();

function renderCatalog() {
  if (!catalogGrid) {
    return;
  }

  catalogGrid.innerHTML = workImages
    .map(
      (item) => `
        <article class="catalog-card${item.contained ? " is-contained" : ""}">
          <figure>
            <img src="${encodeURI(item.file)}" alt="${item.alt}" loading="lazy" />
            <figcaption>
              <strong>${item.label}</strong>
              <span>${item.description}</span>
            </figcaption>
          </figure>
        </article>
      `
    )
    .join("");
}

function setGalleryExpanded(expanded) {
  if (!galleryShell) {
    return;
  }

  galleryShell.classList.toggle("is-collapsed", !expanded);

  toggleGalleryButtons.forEach((button) => {
    button.textContent = expanded ? "Masquer les photos" : "Voir les photos";
  });
}

toggleGalleryButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!galleryShell) {
      return;
    }

    const shouldExpand = galleryShell.classList.contains("is-collapsed");
    setGalleryExpanded(shouldExpand);
    document.querySelector("#trabalho")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

function formatDateLong(dateValue) {
  const parsedDate = new Date(`${dateValue}T12:00:00`);
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(parsedDate);
}

function formatDateShort(dateValue) {
  const parsedDate = new Date(`${dateValue}T12:00:00`);
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parsedDate);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toLocalIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getMondayFirstWeekday(date) {
  const day = date.getDay();
  return day === 0 ? 6 : day - 1;
}

function isSameDay(dateA, dateB) {
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

function normalizeSlotValue(slot) {
  const normalized = String(slot || "").trim();
  return /^\d{2}:\d{2}$/.test(normalized) ? normalized : "";
}

function normalizeSlotsFromText(value) {
  const slots = String(value || "")
    .split(",")
    .map((slot) => normalizeSlotValue(slot))
    .filter(Boolean);

  return [...new Set(slots)].sort();
}

function parseOverrideAvailableInput(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  if (trimmed === "ferme") {
    return {
      useCustomAvailable: true,
      available: [],
    };
  }

  return {
    useCustomAvailable: String(value || "").trim().length > 0,
    available: normalizeSlotsFromText(value),
  };
}

function createDefaultScheduleConfig() {
  return {
    weeklyAvailability: Object.fromEntries(
      Object.entries(defaultAvailabilityByWeekday).map(([key, slots]) => [key, [...slots]])
    ),
    dateOverrides: {},
  };
}

function loadOwnerMode() {
  return window.localStorage.getItem(ownerModeStorageKey) === "true";
}

function saveOwnerMode() {
  window.localStorage.setItem(ownerModeStorageKey, ownerModeEnabled ? "true" : "false");
}

function applyOwnerMode() {
  ownerNavLink?.classList.toggle("is-hidden", !ownerModeEnabled);
  ownerSection?.classList.toggle("is-hidden", !ownerModeEnabled);
}

function loadScheduleConfig() {
  try {
    const saved = window.localStorage.getItem(scheduleStorageKey);
    if (!saved) {
      return createDefaultScheduleConfig();
    }

    const parsed = JSON.parse(saved);
    const base = createDefaultScheduleConfig();

    Object.keys(base.weeklyAvailability).forEach((key) => {
      base.weeklyAvailability[key] = Array.isArray(parsed?.weeklyAvailability?.[key])
        ? [...new Set(parsed.weeklyAvailability[key].map(normalizeSlotValue).filter(Boolean))].sort()
        : [...base.weeklyAvailability[key]];
    });

    if (parsed?.dateOverrides && typeof parsed.dateOverrides === "object") {
      Object.entries(parsed.dateOverrides).forEach(([dateIso, config]) => {
        base.dateOverrides[dateIso] = {
          useCustomAvailable: Boolean(config?.useCustomAvailable),
          available: Array.isArray(config?.available)
            ? [...new Set(config.available.map(normalizeSlotValue).filter(Boolean))].sort()
            : [],
          booked: Array.isArray(config?.booked)
            ? [...new Set(config.booked.map(normalizeSlotValue).filter(Boolean))].sort()
            : [],
        };
      });
    }

    return base;
  } catch {
    return createDefaultScheduleConfig();
  }
}

function saveScheduleConfig() {
  window.localStorage.setItem(scheduleStorageKey, JSON.stringify(scheduleConfig));
}

function showManagerFeedback(message) {
  if (!managerFeedback) {
    return;
  }

  managerFeedback.textContent = message;
  managerFeedback.classList.remove("is-hidden");
}

function toggleOwnerModeWithPrompt() {
  if (ownerModeEnabled) {
    ownerModeEnabled = false;
    saveOwnerMode();
    applyOwnerMode();
    return;
  }

  const enteredCode = window.prompt(
    "Code proprietaire :"
  );

  if (!enteredCode) {
    return;
  }

  if (enteredCode.trim() !== ownerAccessCode) {
    window.alert("Code incorrect.");
    return;
  }

  ownerModeEnabled = true;
  saveOwnerMode();
  applyOwnerMode();
  ownerSection?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function getWeeklySlotsForWeekday(weekday) {
  return scheduleConfig.weeklyAvailability[String(weekday)] || [];
}

function getDateOverride(dateIso) {
  return scheduleConfig.dateOverrides[dateIso] || {
    useCustomAvailable: false,
    available: [],
    booked: [],
  };
}

function getDaySchedule(date) {
  const dateIso = toLocalIsoDate(date);
  const weekday = date.getDay();
  const override = getDateOverride(dateIso);
  const defaultSlots = getWeeklySlotsForWeekday(weekday);
  const availableSlots = override.useCustomAvailable ? override.available : defaultSlots;
  const allSlots = [...new Set([...availableSlots, ...override.booked])].sort();

  return allSlots.map((slot) => ({
    time: slot,
    status: override.booked.includes(slot) ? "busy" : "available",
  }));
}

function getAvailabilitySummary(date) {
  const schedule = getDaySchedule(date);
  const availableCount = schedule.filter((slot) => slot.status === "available").length;

  return {
    schedule,
    availableCount,
    isUnavailable: schedule.length === 0 || availableCount === 0,
  };
}

function getSlotAvailability(dateIso, timeValue) {
  const normalizedTime = normalizeSlotValue(timeValue);
  if (!dateIso || !normalizedTime) {
    return { valid: false, reason: "empty" };
  }

  const schedule = getDaySchedule(new Date(`${dateIso}T12:00:00`));
  const slot = schedule.find((item) => item.time === normalizedTime);

  if (!slot) {
    return { valid: false, reason: "missing" };
  }

  if (slot.status !== "available") {
    return { valid: false, reason: "busy" };
  }

  return { valid: true, reason: "available", slotId: slot.id || null };
}

function showBookingError(message) {
  if (!bookingError) {
    return;
  }

  bookingError.textContent = message;
  bookingError.classList.remove("is-hidden");
}

function hideBookingError() {
  bookingError?.classList.add("is-hidden");
}

function validateBookingSelection() {
  if (!bookingDateInput || !bookingTimeInput) {
    return true;
  }

  const dateIso = bookingDateInput.value;
  const timeValue = bookingTimeInput.value;

  if (!dateIso || !timeValue) {
    hideBookingError();
    return true;
  }

  const slotState = getSlotAvailability(dateIso, timeValue);

  if (!slotState.valid) {
    showBookingError("Ce creneau n'est pas disponible. Merci de choisir un horaire en vert.");
    return false;
  }

  hideBookingError();
  return true;
}

function populateWeeklyConfigForm() {
  if (!weeklyConfigForm) {
    return;
  }

  Object.entries(scheduleConfig.weeklyAvailability).forEach(([weekday, slots]) => {
    const input = weeklyConfigForm.querySelector(`[name="day-${weekday}"]`);
    if (input) {
      input.value = slots.join(", ");
    }
  });
}

function populateOverrideForm(dateIso) {
  if (!overrideDateInput || !overrideAvailableInput || !overrideBookedInput || !dateIso) {
    return;
  }

  const override = getDateOverride(dateIso);
  overrideDateInput.value = dateIso;
  overrideAvailableInput.value = override.useCustomAvailable
    ? override.available.length
      ? override.available.join(", ")
      : "ferme"
    : "";
  overrideBookedInput.value = override.booked.join(", ");
}

function refreshAgendaViews() {
  renderCalendar();
  renderSelectedDay(selectedCalendarDate);

  if (bookingDateInput?.value && bookingTimeInput?.value) {
    validateBookingSelection();
  }
}

function renderCalendar() {
  if (!calendarGrid || !calendarTitle) {
    return;
  }

  const monthStart = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth(), 1);
  const startOffset = getMondayFirstWeekday(monthStart);
  const totalCells = 42;
  const gridStartDate = new Date(monthStart);
  gridStartDate.setDate(monthStart.getDate() - startOffset);

  calendarTitle.textContent = new Intl.DateTimeFormat("fr-FR", {
    month: "long",
    year: "numeric",
  }).format(monthStart);

  calendarGrid.innerHTML = Array.from({ length: totalCells }, (_, index) => {
    const date = new Date(gridStartDate);
    date.setDate(gridStartDate.getDate() + index);

    const dateIso = toLocalIsoDate(date);
    const isCurrentMonth = date.getMonth() === monthStart.getMonth();
    const isToday = isSameDay(date, today);
    const isSelected = selectedCalendarDate ? isSameDay(date, selectedCalendarDate) : false;
    const { availableCount, isUnavailable } = getAvailabilitySummary(date);

    return `
      <button
        class="calendar-day ${isCurrentMonth ? "" : "is-other-month"} ${isToday ? "is-today" : ""} ${isSelected ? "is-selected" : ""} ${isUnavailable ? "is-unavailable" : ""}"
        type="button"
        data-date="${dateIso}"
      >
        <span class="calendar-day-head">
          <span class="calendar-day-number">${date.getDate()}</span>
          <span class="calendar-dot" aria-hidden="true"></span>
        </span>
        <span class="calendar-day-note">
          ${isUnavailable ? "Aucun creneau" : `${availableCount} creneau(x) disponible(s)`}
        </span>
      </button>
    `;
  }).join("");
}

function renderSelectedDay(date) {
  if (!selectedDayTitle || !selectedDayMeta || !daySlotsGrid) {
    return;
  }

  const schedule = getDaySchedule(date);
  const dateLabel = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);

  selectedDayTitle.textContent = dateLabel;

  if (!schedule.length) {
    selectedDayMeta.textContent = "Aucune disponibilite n'est prevue pour cette date.";
    daySlotsGrid.innerHTML = '<span class="agenda-empty">Journee complete</span>';
    return;
  }

  const availableCount = schedule.filter((slot) => slot.status === "available").length;
  selectedDayMeta.textContent =
    availableCount > 0
      ? "Le vert indique un horaire disponible. Le rouge indique un horaire deja reserve."
      : "Tous les horaires de cette date sont deja reserves.";

  const selectedIso = toLocalIsoDate(date);

  daySlotsGrid.innerHTML = schedule
    .map((slot) => {
      const isSelectedSlot =
        bookingDateInput?.value === selectedIso &&
        bookingTimeInput?.value === slot.time &&
        slot.status === "available";

      if (slot.status === "busy") {
        return `
          <button class="agenda-slot is-busy" type="button" disabled aria-disabled="true">
            ${slot.time}
          </button>
        `;
      }

      return `
        <button
          class="agenda-slot is-available ${isSelectedSlot ? "is-selected" : ""}"
          type="button"
          data-date="${selectedIso}"
          data-time="${slot.time}"
          data-label="${escapeHtml(`${dateLabel} - ${slot.time}`)}"
        >
          ${slot.time}
        </button>
      `;
    })
    .join("");
}

calendarGrid?.addEventListener("click", (event) => {
  const button = event.target.closest(".calendar-day");
  if (!button) {
    return;
  }

  selectedCalendarDate = new Date(`${button.dataset.date}T12:00:00`);
  currentMonthDate = new Date(
    selectedCalendarDate.getFullYear(),
    selectedCalendarDate.getMonth(),
    1
  );
  populateOverrideForm(button.dataset.date);
  refreshAgendaViews();
});

daySlotsGrid?.addEventListener("click", (event) => {
  const button = event.target.closest(".agenda-slot");
  if (!button) {
    return;
  }

  if (button.classList.contains("is-busy")) {
    showBookingError("Ce creneau n'est pas disponible. Merci de choisir un horaire en vert.");
    return;
  }

  if (!bookingDateInput || !bookingTimeInput || !selectedSlotText) {
    return;
  }

  bookingDateInput.value = button.dataset.date;
  bookingTimeInput.value = button.dataset.time;
  selectedSlotText.textContent = `Creneau choisi : ${button.dataset.label}`;

  if (selectedAgendaButton) {
    selectedAgendaButton.classList.remove("is-selected");
  }

  button.classList.add("is-selected");
  selectedAgendaButton = button;
  hideBookingError();

  document.querySelector("#pre-agendamento")?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
});

calendarPrevButton?.addEventListener("click", () => {
  currentMonthDate = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth() - 1, 1);
  renderCalendar();
});

calendarNextButton?.addEventListener("click", () => {
  currentMonthDate = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth() + 1, 1);
  renderCalendar();
});

bookingDateInput?.addEventListener("change", () => {
  if (!bookingDateInput.value) {
    return;
  }

  selectedCalendarDate = new Date(`${bookingDateInput.value}T12:00:00`);
  currentMonthDate = new Date(
    selectedCalendarDate.getFullYear(),
    selectedCalendarDate.getMonth(),
    1
  );
  populateOverrideForm(bookingDateInput.value);
  refreshAgendaViews();
});

bookingTimeInput?.addEventListener("change", () => {
  validateBookingSelection();
  renderSelectedDay(selectedCalendarDate);
});

weeklyConfigForm?.addEventListener("submit", (event) => {
  event.preventDefault();

  Object.keys(defaultAvailabilityByWeekday).forEach((weekday) => {
    const input = weeklyConfigForm.querySelector(`[name="day-${weekday}"]`);
    scheduleConfig.weeklyAvailability[weekday] = normalizeSlotsFromText(input?.value || "");
  });

  saveScheduleConfig();
  showManagerFeedback("Le planning hebdomadaire a ete enregistre avec succes.");
  refreshAgendaViews();
});

overrideDateInput?.addEventListener("change", () => {
  if (!overrideDateInput.value) {
    return;
  }

  populateOverrideForm(overrideDateInput.value);
});

dateOverrideForm?.addEventListener("submit", (event) => {
  event.preventDefault();

  const dateIso = overrideDateInput?.value;
  if (!dateIso) {
    return;
  }

  const parsedAvailable = parseOverrideAvailableInput(overrideAvailableInput?.value || "");
  const bookedSlots = normalizeSlotsFromText(overrideBookedInput?.value || "");

  scheduleConfig.dateOverrides[dateIso] = {
    useCustomAvailable: parsedAvailable.useCustomAvailable,
    available: parsedAvailable.available,
    booked: bookedSlots,
  };

  saveScheduleConfig();
  selectedCalendarDate = new Date(`${dateIso}T12:00:00`);
  currentMonthDate = new Date(
    selectedCalendarDate.getFullYear(),
    selectedCalendarDate.getMonth(),
    1
  );
  showManagerFeedback("La configuration de cette date a bien ete enregistree.");
  refreshAgendaViews();
});

resetDateOverrideButton?.addEventListener("click", () => {
  const dateIso = overrideDateInput?.value;
  if (!dateIso) {
    return;
  }

  delete scheduleConfig.dateOverrides[dateIso];
  saveScheduleConfig();
  populateOverrideForm(dateIso);
  selectedCalendarDate = new Date(`${dateIso}T12:00:00`);
  currentMonthDate = new Date(
    selectedCalendarDate.getFullYear(),
    selectedCalendarDate.getMonth(),
    1
  );
  showManagerFeedback("La personnalisation de cette date a ete reinitialisee.");
  refreshAgendaViews();
});

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "g") {
    event.preventDefault();
    toggleOwnerModeWithPrompt();
  }
});

whatsappForm?.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!validateBookingSelection()) {
    bookingDateInput?.focus();
    return;
  }

  const formData = new FormData(whatsappForm);
  const nome = String(formData.get("nome") || "").trim();
  const telefone = String(formData.get("telefone") || "").trim();
  const unidade = String(formData.get("unidade") || "").trim();
  const servico = String(formData.get("servico") || "").trim();
  const data = String(formData.get("data") || "").trim();
  const hora = String(formData.get("hora") || "").trim();
  const mensagemAdicional = String(formData.get("mensagem") || "").trim();
  const formattedDateLong = data ? formatDateLong(data) : "Non renseignee";
  const formattedDateShort = data ? formatDateShort(data) : "Non renseignee";

  const messageLines = [
    "Bonjour, je souhaite prendre un rendez-vous.",
    "",
    `Nom: ${nome}`,
    `WhatsApp: ${telefone}`,
    `Lieu: ${unidade}`,
    `Prestation: ${servico}`,
    `Date souhaitee: ${formattedDateShort}`,
    `Horaire souhaite: ${hora || "Non renseigne"}`,
    `Message: ${mensagemAdicional || "Aucun detail complementaire."}`,
  ];

  const message = messageLines.join("\n");
  const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;

  if (bookingOutput) {
    bookingOutput.innerHTML = `
      <p><strong>Message pret a etre envoye.</strong></p>
      <ul>
        <li><strong>Nom:</strong> ${escapeHtml(nome)}</li>
        <li><strong>WhatsApp:</strong> ${escapeHtml(telefone)}</li>
        <li><strong>Lieu:</strong> ${escapeHtml(unidade)}</li>
        <li><strong>Prestation:</strong> ${escapeHtml(servico)}</li>
        <li><strong>Date:</strong> ${escapeHtml(formattedDateLong)}</li>
        <li><strong>Horaire:</strong> ${escapeHtml(hora || "Non renseigne")}</li>
        <li><strong>Message:</strong> ${escapeHtml(
          mensagemAdicional || "Aucun detail complementaire."
        )}</li>
      </ul>
    `;
  }

  if (whatsappLink) {
    whatsappLink.href = whatsappUrl;
    whatsappLink.classList.remove("is-hidden");
  }

  hideBookingError();
  window.open(whatsappUrl, "_blank", "noopener");
});

renderCatalog();
applyOwnerMode();
populateWeeklyConfigForm();
populateOverrideForm(toLocalIsoDate(selectedCalendarDate));
refreshAgendaViews();
setGalleryExpanded(false);
