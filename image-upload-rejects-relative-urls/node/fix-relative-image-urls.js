/**
 * Find zero-image BigCommerce products and fix the non fully qualified image_url cause.
 *
 * BigCommerce creates a product image by URL through
 * POST /v3/catalog/products/{product_id}/images with a JSON body containing
 * image_url, and BigCommerce's own servers fetch that remote file server-side.
 * Because of that server-side fetch, image_url must be a fully qualified absolute
 * URL, a scheme (http or https) plus a host. A relative path, a protocol-relative
 * URL, or a bare filename has no scheme or host for BigCommerce's fetcher to
 * resolve, so the request is rejected with a 422 image_url is invalid error. This
 * hits bulk or CSV migration imports the hardest, since the source system often
 * stored image paths relative to its own web root. The product record itself is
 * created before the image call runs, so the failed image row does not roll back
 * the product, it just leaves a real product with zero images and no automatic
 * retry.
 *
 * This job lists every zero-image product, cross-references each one against the
 * import job's failure log for the original image_url, and uses a pure decision
 * function to classify it as already valid, fixable against a known source base
 * URL, or in need of human review. It only retries the create-image call for the
 * first two cases. Nothing is ever guessed; a URL that cannot be safely resolved
 * is routed to review instead of risking the wrong image on the wrong product.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/image-upload-rejects-relative-urls/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const SOURCE_BASE_URL = process.env.SOURCE_BASE_URL || null;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no I/O.
 *
 * If rawUrl already parses with protocol http/https and a non-empty host, it
 * is already_valid. If rawUrl has a scheme that is neither http nor https
 * (ftp, data, and so on), it is unsupported_scheme. Otherwise it is treated
 * as the non fully qualified defect: if sourceBaseUrl is itself a valid
 * absolute http/https URL, resolve rawUrl against it and return fixable. If
 * there is no usable base URL, return needs_review.
 */
export function isFixableImageUrl(rawUrl, sourceBaseUrl = null) {
  let parts;
  let hasRealScheme = true;
  try {
    parts = new URL(rawUrl || "");
  } catch {
    hasRealScheme = false;
  }

  if (hasRealScheme) {
    const scheme = parts.protocol.replace(":", "");
    if ((scheme === "http" || scheme === "https") && parts.host) {
      return { status: "already_valid", resolvedUrl: rawUrl };
    }
    if (scheme !== "http" && scheme !== "https") {
      return { status: "unsupported_scheme", resolvedUrl: null };
    }
  }

  let baseIsValid = false;
  if (sourceBaseUrl) {
    try {
      const base = new URL(sourceBaseUrl);
      baseIsValid = base.protocol === "http:" || base.protocol === "https:";
    } catch {
      baseIsValid = false;
    }
  }

  if (baseIsValid) {
    return { status: "fixable", resolvedUrl: new URL(rawUrl || "", sourceBaseUrl).href };
  }

  return { status: "needs_review", resolvedUrl: null };
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function bcPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function* zeroImageProducts() {
  let page = 1;
  while (true) {
    const resp = await bcGet("/catalog/products", { include: "images", limit: 250, page });
    const products = resp.data || [];
    if (!products.length) return;
    for (const product of products) {
      if (!product.images || !product.images.length) yield product;
    }
    const totalPages = resp.meta?.pagination?.total_pages ?? page;
    if (page >= totalPages) return;
    page += 1;
  }
}

function failedImageUrlFor(productId, failureLog) {
  return failureLog[productId] ?? null;
}

async function createProductImage(productId, resolvedUrl) {
  return bcPost(`/catalog/products/${productId}/images`, {
    image_url: resolvedUrl,
    is_thumbnail: true,
  });
}

export async function run(failureLog = {}) {
  let retried = 0;
  let reviewed = 0;

  for await (const product of zeroImageProducts()) {
    const productId = product.id;
    const rawUrl = failedImageUrlFor(productId, failureLog);

    if (rawUrl === null) {
      console.log(`product_id=${productId} has zero images but no matching failure log entry, skipping`);
      continue;
    }

    const decision = isFixableImageUrl(rawUrl, SOURCE_BASE_URL);

    if (decision.status === "needs_review" || decision.status === "unsupported_scheme") {
      console.warn(`product_id=${productId} needs review. status=${decision.status} original_image_url=${rawUrl}`);
      reviewed += 1;
      continue;
    }

    const resolvedUrl = decision.resolvedUrl;
    console.log(
      `product_id=${productId} status=${decision.status} original_image_url=${rawUrl} ` +
      `resolved_url=${resolvedUrl} (${DRY_RUN ? "dry run" : "retrying"})`
    );
    if (!DRY_RUN) await createProductImage(productId, resolvedUrl);
    retried += 1;
  }

  console.log(
    `Done. ${retried} product(s) ${DRY_RUN ? "to retry" : "retried"}, ${reviewed} product(s) routed to review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
