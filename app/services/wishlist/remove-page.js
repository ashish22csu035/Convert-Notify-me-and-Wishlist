export async function removeWishlistEntryFromPage({
  button,
  entryId,
  card,
  list,
  fetcher,
  documentRef,
  endpoint,
  emptyClass,
  errorClass,
  detailsSelector,
  emptyMessage,
}) {
  if (button.disabled) return false;

  card.querySelector("[role='alert']")?.remove();
  button.disabled = true;
  button.textContent = "Removing...";

  try {
    const response = await fetcher(endpoint, {
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId }),
    });
    const result = await response.json();
    if (!response.ok || result?.removed !== true) {
      throw new Error("Wishlist item could not be removed");
    }

    card.remove();
    if (!list.querySelector("li")) {
      const empty = documentRef.createElement("p");
      empty.className = emptyClass;
      empty.textContent = emptyMessage;
      list.replaceWith(empty);
    }
    return true;
  } catch {
    const error = documentRef.createElement("p");
    error.className = errorClass;
    error.setAttribute("role", "alert");
    error.textContent = "We couldn't remove this item. Try removing again.";
    card.querySelector(detailsSelector)?.append(error);
    button.disabled = false;
    button.textContent = "Remove";
    return false;
  }
}
