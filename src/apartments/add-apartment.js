const form = document.getElementById("add-apartment-form");
const nameInput = document.getElementById("apartment-name");
const addressInput = document.getElementById("apartment-address");
const roomsInput = document.getElementById("apartment-rooms");
const saveButton = document.getElementById("save-button");
const statusEl = document.getElementById("status");

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const name = nameInput.value.trim();
  if (!name) {
    statusEl.textContent = "Apartment name is required";
    statusEl.classList.add("error");
    return;
  }

  const newApartment = {
    id: crypto.randomUUID(),
    name,
    address: addressInput.value.trim(),
    rooms: roomsInput.value ? parseInt(roomsInput.value, 10) : null,
    updatedAt: new Date().toISOString(),
  };

  saveButton.disabled = true;
  statusEl.textContent = "Saving…";
  statusEl.classList.remove("error");

  loadApartments()
    .then((data) => saveApartments([...(data.apartments || []), newApartment]))
    .then(() => {
      window.location.href = "apartments.html";
    })
    .catch((err) => {
      console.error("Failed to save apartment:", err);
      statusEl.textContent = "Failed to save apartment";
      statusEl.classList.add("error");
      saveButton.disabled = false;
    });
});
