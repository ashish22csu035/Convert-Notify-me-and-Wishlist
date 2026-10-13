import { loadMerchantReporting } from "../services/reporting/route.js";

export async function loader({ request }) {
  return loadMerchantReporting(request);
}
