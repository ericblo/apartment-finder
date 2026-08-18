const listEl = document.getElementById("apartment-list");
const statusEl = document.getElementById("status");

function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
}

function renderApartments(apartments) {
  listEl.innerHTML = "";

  if (!apartments.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No apartments yet. Add one to get started.";
    listEl.appendChild(empty);
    return;
  }

  apartments.forEach((apartment) => {
    const card = document.createElement("a");
    card.className = "apartment-card";
    card.href = `../floorplan/floorplan.html?apartment=${encodeURIComponent(apartment.id)}`;

    const icon = document.createElement("div");
    icon.className = "apartment-icon";
    icon.textContent = "🏠";
    card.appendChild(icon);

    const info = document.createElement("div");
    info.className = "apartment-info";

    const name = document.createElement("p");
    name.className = "apartment-name";
    name.textContent = apartment.name;
    info.appendChild(name);

    const meta = document.createElement("p");
    meta.className = "apartment-meta";
    const roomText = apartment.rooms
      ? `${apartment.rooms} room${apartment.rooms === 1 ? "" : "s"}`
      : "Rooms not set";
    meta.textContent = `${roomText} • updated ${relativeTime(apartment.updatedAt)}`;
    info.appendChild(meta);

    card.appendChild(info);

    const chevron = document.createElement("span");
    chevron.className = "apartment-chevron";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");
    card.appendChild(chevron);

    listEl.appendChild(card);
  });
}

loadApartments()
  .then((data) => {
    renderApartments(data.apartments || []);
  })
  .catch((err) => {
    console.error("Failed to load apartments:", err);
    statusEl.textContent = "Failed to load apartments";
    statusEl.classList.add("error");
  });
