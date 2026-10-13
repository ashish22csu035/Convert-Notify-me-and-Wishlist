import {
  isRouteErrorResponse,
  redirect,
  useLoaderData,
  useRouteError,
} from "react-router";
import { authenticate } from "../../shopify.server.js";
import applicationDb from "../../application-db.server.js";
import { listWishlistEntries } from "../../services/wishlist/index.js";
import { loadWishlistPageEntries } from "../../services/wishlist/page-data.server.js";
import { removeWishlistEntryFromPage } from "../../services/wishlist/remove-page.js";
import { authenticateAppProxyCustomer } from "../../utils/app-proxy-customer.server.js";
import styles from "../../styles/my-wishlist.module.css";

const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const STOREFRONT_WISHLIST_PATH = "/apps/konvert-notify/my-wishlist";
const WISHLIST_API_PATH = "/apps/konvert-notify/wishlist";

function loginUrlFor(shopDomain) {
  const login = new URL(
    "/customer_authentication/login",
    `https://${shopDomain}`,
  );
  login.searchParams.set("return_to", STOREFRONT_WISHLIST_PATH);
  return login.toString();
}

async function getSignedProxyContext(request) {
  let proxyContext;
  try {
    proxyContext = await authenticate.public.appProxy(request);
  } catch (error) {
    if (error instanceof Response && error.status < 500) return null;
    throw error;
  }

  const sessionShop =
    typeof proxyContext.session?.shop === "string"
      ? proxyContext.session.shop.toLowerCase()
      : null;
  const signedShop = new URL(request.url).searchParams.get("shop")?.toLowerCase();
  if (
    !proxyContext.admin ||
    typeof sessionShop !== "string" ||
    !SHOP_DOMAIN_PATTERN.test(sessionShop) ||
    signedShop !== sessionShop
  ) {
    return null;
  }
  return { proxyContext, shopDomain: sessionShop };
}

export async function loader({ request }) {
  const proxy = await getSignedProxyContext(request);
  if (!proxy) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const featureSettings = await applicationDb.shop.findUnique({
    where: { domain: proxy.shopDomain },
    select: { wishlistEnabled: true },
  });
  if (featureSettings?.wishlistEnabled === false) {
    throw new Response("Wishlist is disabled", { status: 404 });
  }

  const identity = await authenticateAppProxyCustomer(
    request,
    async () => proxy.proxyContext,
  );
  if (!identity) {
    throw redirect(loginUrlFor(proxy.shopDomain));
  }

  try {
    const shop = await applicationDb.shop.findUnique({
      where: { domain: identity.shopDomain },
      select: { id: true, shopifyShopId: true },
    });
    if (!shop) {
      throw new Error("Wishlist shop was not found");
    }

    const entries = await listWishlistEntries({
      shopId: shop.id,
      customerShopifyId: identity.customerShopifyId,
    });
    const pageEntries = await loadWishlistPageEntries({
      admin: identity.admin,
      shopifyShopId: shop.shopifyShopId,
      shopDomain: identity.shopDomain,
      entries,
    });
    return { entries: pageEntries };
  } catch (error) {
    console.error(
      "My Wishlist failed to load",
      error instanceof Error ? error.name : "UnknownError",
    );
    throw new Response("Wishlist unavailable", { status: 500 });
  }
}

function formatPrice(price) {
  if (!price) return "Price unavailable";
  const amount = Number(price.amount);
  if (!Number.isFinite(amount)) return "Price unavailable";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: price.currencyCode,
    }).format(amount);
  } catch {
    return `${price.amount} ${price.currencyCode}`;
  }
}

export default function MyWishlistPage() {
  const { entries: initialEntries } = useLoaderData();

  return (
    <main className={styles.page}>
      <h1 className={styles.heading}>My Wishlist</h1>
      {initialEntries.length === 0 ? (
        <p className={styles.empty}>
          No Wishlist items have been saved yet.
        </p>
      ) : (
        <ul className={styles.list}>
          {initialEntries.map((entry) => {
            const productAvailable = entry.productState === "available";
            const product = entry.product;
            return (
              <li className={styles.card} key={entry.id}>
                {product?.imageUrl ? (
                  <img
                    className={styles.image}
                    src={product.imageUrl}
                    alt={product.imageAlt || ""}
                    loading="lazy"
                  />
                ) : (
                  <div className={styles.imagePlaceholder} aria-hidden="true" />
                )}
                <div className={styles.details}>
                  <h2 className={styles.productTitle}>
                    {productAvailable ? (
                      <a href={product.url}>{product.title}</a>
                    ) : (
                      "This product is no longer available"
                    )}
                  </h2>
                  {productAvailable && (
                    <>
                      <p className={styles.price}>
                        {formatPrice(product.price)}
                      </p>
                      {entry.variant ? (
                        <p className={styles.variant}>
                          Preferred option: {entry.variant.title}
                        </p>
                      ) : entry.preferredVariantShopifyId ? (
                        <p className={styles.variant}>
                          The saved option is no longer available.
                        </p>
                      ) : null}
                      <p className={styles.availability}>
                        {entry.variantState === "available"
                          ? "Available"
                          : entry.variantState === "unavailable"
                            ? "Unavailable"
                            : entry.variantState === "invalid"
                              ? "Saved option unavailable"
                              : "Choose an option"}
                      </p>
                    </>
                  )}
                  {!productAvailable && (
                    <p className={styles.availability}>
                      Product unavailable
                    </p>
                  )}
                  <div className={styles.actions}>
                    {entry.canAddToCart && (
                      <form action="/cart/add" method="post">
                        <input
                          type="hidden"
                          name="id"
                          value={entry.variant.numericId}
                        />
                        <input type="hidden" name="quantity" value="1" />
                        <button
                          className={styles.primaryButton}
                          type="submit"
                        >
                          Add to Cart
                        </button>
                      </form>
                    )}
                    {entry.canNotify && (
                      <a
                        className={styles.primaryButton}
                        href={`${product.url}?variant=${encodeURIComponent(entry.variant.numericId)}#konvert-notify`}
                      >
                        Notify Me
                      </a>
                    )}
                    {entry.canChooseOptions && product?.url && (
                      <a
                        className={styles.secondaryButton}
                        href={product.url}
                      >
                        Choose Options
                      </a>
                    )}
                    {product?.url && (
                      <a
                        className={styles.secondaryButton}
                        href={product.url}
                      >
                        View Product
                      </a>
                    )}
                    <button
                      className={styles.removeButton}
                      type="button"
                      data-wishlist-remove
                      data-entry-id={entry.id}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            const removeWishlistEntryFromPage = (${removeWishlistEntryFromPage.toString()});
            document.addEventListener("click", (event) => {
              if (!(event.target instanceof Element)) return;
              const button = event.target.closest("[data-wishlist-remove]");
              if (!button || button.disabled) return;
              event.preventDefault();
              event.stopPropagation();

              const entryId = button.dataset.entryId;
              const card = button.closest("li");
              const list = card?.parentElement;
              if (!entryId || !card || !list) return;

              void removeWishlistEntryFromPage({
                button,
                entryId,
                card,
                list,
                fetcher: (...args) => fetch(...args),
                documentRef: document,
                endpoint: "${WISHLIST_API_PATH}",
                emptyClass: "${styles.empty}",
                errorClass: "${styles.error}",
                detailsSelector: ".${styles.details}",
                emptyMessage: "No Wishlist items have been saved yet.",
              });
            }, true);
          `,
        }}
      />
    </main>
  );
}

export function HydrateFallback() {
  return (
    <main className={styles.page}>
      <h1 className={styles.heading}>My Wishlist</h1>
      <p role="status">Loading your Wishlist...</p>
    </main>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error)
    ? error.status
    : error instanceof Response
      ? error.status
      : 500;
  if (status === 401) {
    return (
      <main className={styles.page}>
        <h1 className={styles.heading}>My Wishlist</h1>
        <p role="alert">Please log in to view your Wishlist.</p>
      </main>
    );
  }
  return (
    <main className={styles.page}>
      <h1 className={styles.heading}>My Wishlist</h1>
      <p className={styles.error} role="alert">
        We could not load your Wishlist. Please refresh and try again.
      </p>
    </main>
  );
}
