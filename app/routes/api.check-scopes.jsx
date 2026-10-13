import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`
    #graphql
    query AccessScopeList {
      currentAppInstallation {
        accessScopes {
          handle
        }
      }
    }
  `);

  const data = await response.json();

  return Response.json(data);
}