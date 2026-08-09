let itemLocations = {};

const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const resultEl = document.getElementById("result");
const suggestionsEl = document.getElementById("item-suggestions");
const rooms = document.querySelectorAll(".room");

function populateSuggestions() {
  suggestionsEl.innerHTML = "";
  Object.keys(itemLocations).forEach((item) => {
    const option = document.createElement("option");
    option.value = item;
    suggestionsEl.appendChild(option);
  });
}

function clearHighlights() {
  rooms.forEach((room) => {
    room.classList.remove("highlighted");
    const pin = room.querySelector(".pin");
    if (pin) pin.remove();
  });
}

function highlightRoom(roomName) {
  const room = Array.from(rooms).find((r) => r.dataset.room === roomName);
  if (!room) return;

  room.classList.add("highlighted");

  const pin = document.createElement("span");
  pin.className = "pin";
  pin.textContent = "📍";
  room.appendChild(pin);
}

function handleSearch(event) {
  event.preventDefault();

  const query = searchInput.value.trim().toLowerCase();
  clearHighlights();

  if (!query) {
    resultEl.textContent = "";
    resultEl.className = "result";
    return;
  }

  const room = itemLocations[query];

  if (room) {
    resultEl.textContent = `Last seen in: ${room}`;
    resultEl.className = "result found";
    highlightRoom(room);
  } else {
    resultEl.textContent = `No record of "${searchInput.value.trim()}". Try: ${Object.keys(itemLocations).join(", ")}.`;
    resultEl.className = "result not-found";
  }
}

function loadItems() {
  fetch("items.json")
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      itemLocations = data;
    })
    .catch((err) => {
      console.warn("Could not load items.json — starting with no items.", err);
      itemLocations = {};
    })
    .finally(() => {
      populateSuggestions();
    });
}

searchForm.addEventListener("submit", handleSearch);

loadItems();
