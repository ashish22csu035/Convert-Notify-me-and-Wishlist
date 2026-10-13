import { loadWishlistAnalytics } from "../services/reporting/wishlist-route.js";

export async function loader({ request }) {
  return loadWishlistAnalytics(request);
}
