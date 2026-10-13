import { loadOperationalContacts } from "../services/reporting/demand-route.js";

export async function loader({ request }) {
  return loadOperationalContacts(request);
}
