import {
  loadDemandAndRequests,
  retryDemandHandoff,
} from "../services/reporting/demand-route.js";

export async function loader({ request }) {
  return loadDemandAndRequests(request);
}

export async function action({ request }) {
  return retryDemandHandoff(request);
}
