<script lang="ts">
  import ItemHistoryValue from "$lib/components/ItemHistoryValue.svelte";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import { toGoogleDrivePublicImageUrl } from "$lib/drive-url";
  import type {
    FieldDiffDetail,
    GalleryImageDiffDetail,
    VariantDiffDetail,
    VariantDiffField,
  } from "$lib/shopify-deep-diff";

  export let issue: string;
  export let row: any;

  function displayValue(value: unknown): string {
    const text = String(value ?? "").trim();
    return text || "(blank)";
  }

  function variantHasField(
    detail: VariantDiffDetail,
    field: VariantDiffField,
  ): boolean {
    return detail.fields.includes(field);
  }

  function isBareShopifySku(detail: VariantDiffDetail): boolean {
    const localSku = String(detail.local?.sku || "").trim();
    const localJan = String(detail.local?.janCode || "").trim();
    const remoteSku = String(detail.remote?.sku || "").trim();
    return (
      detail.matchType !== "singleJan" &&
      variantHasField(detail, "sku") &&
      !!localSku &&
      !!remoteSku &&
      /^\d+$/.test(remoteSku) &&
      (remoteSku === localJan || localSku.startsWith(remoteSku)) &&
      localSku !== remoteSku
    );
  }

  function variantName(detail: VariantDiffDetail): string {
    return (
      displayValue(detail.local?.subtype || detail.remote?.subtype) ||
      displayValue(detail.local?.sku || detail.remote?.sku)
    );
  }

  function thumbnailSrc(value: unknown): string {
    const text = String(value || "").trim();
    if (text.startsWith("drive:")) {
      return toGoogleDrivePublicImageUrl(text.slice("drive:".length));
    }
    return text;
  }

  function variantImage(detail: VariantDiffDetail): string {
    return thumbnailSrc(detail.local?.image || detail.remote?.image);
  }

  function galleryImage(diff: GalleryImageDiffDetail): string {
    return thumbnailSrc(diff.local?.url || diff.remote?.url);
  }

  function variantFieldRows(field: VariantDiffField): VariantDiffDetail[] {
    return (row.diffDetails?.variantDiffs || []).filter(
      (detail: VariantDiffDetail) => variantHasField(detail, field),
    );
  }

  function singleJanRows(): VariantDiffDetail[] {
    return (row.diffDetails?.variantDiffs || []).filter(
      (detail: VariantDiffDetail) => detail.matchType === "singleJan",
    );
  }

  function variantIdentityRows(): VariantDiffDetail[] {
    return (row.diffDetails?.variantDiffs || []).filter(
      (detail: VariantDiffDetail) =>
        detail.matchType !== "singleJan" &&
        (variantHasField(detail, "subtype") ||
          variantHasField(detail, "janCode") ||
          (variantHasField(detail, "sku") && !isBareShopifySku(detail))),
    );
  }

  function metadataRows(): FieldDiffDetail[] {
    return row.diffDetails?.fieldDiffs || [];
  }

  function galleryRows(): GalleryImageDiffDetail[] {
    return row.diffDetails?.galleryImageDiffs || [];
  }

  function bareSkuRows(): VariantDiffDetail[] {
    return (row.diffDetails?.variantDiffs || []).filter(isBareShopifySku);
  }

  function variantStructureRows(): VariantDiffDetail[] {
    return (row.diffDetails?.variantDiffs || []).filter(
      (diff: VariantDiffDetail) =>
        diff.matchType === "missingLocal" || diff.matchType === "missingRemote",
    );
  }

  function metadataRowsForIssue(): FieldDiffDetail[] {
    return metadataRows().filter((diff) =>
      issue === "status"
        ? diff.key === "status"
        : issue === "category"
          ? diff.key === "productCategory" || diff.key === "productType"
          : true,
    );
  }

  function fieldLabel(field: string): string {
    const labels: Record<string, string> = {
      sku: "SKU",
      subtype: "Subtype",
      price: "Price",
      janCode: "JAN",
      weight: "Weight",
      inventoryQuantity: "On Hand",
      image: "Image",
      productCategory: "Category",
      productType: "Product Type",
      option1Name: "Option Name",
      bodyHtml: "Body HTML",
      title: "Title",
      status: "Status",
      handle: "Handle",
      url: "URL",
      altText: "Alt Text",
    };
    return labels[field] || field;
  }

  function variantRowsForIssue(): VariantDiffDetail[] {
    if (issue === "price") return variantFieldRows("price");
    if (issue === "weight") return variantFieldRows("weight");
    if (issue === "single_jan_subtype") return singleJanRows();
    return variantIdentityRows();
  }

  function variantFieldsForIssue(diff: VariantDiffDetail): VariantDiffField[] {
    return diff.fields.filter((field) =>
      issue === "price"
        ? field === "price"
        : issue === "weight"
          ? field === "weight"
          : issue === "single_jan_subtype"
            ? true
            : field === "sku" || field === "subtype" || field === "janCode",
    );
  }
</script>

<div class="issue-detail">
  {#if issue === "bare_sku"}
    <table class="mini-table">
      <thead>
        <tr>
          <th class="image-column">Image</th>
          <th>Variant</th>
          <th>Admin SKU</th>
          <th>Shopify SKU</th>
        </tr>
      </thead>
      <tbody>
        {#each bareSkuRows() as diff}
          <tr>
            <td class="image-cell">
              {#if variantImage(diff)}
                <ImageThumbnail
                  src={variantImage(diff)}
                  alt={variantName(diff)}
                  width="44px"
                  height="44px"
                  fit="contain"
                />
              {/if}
            </td>
            <td>{variantName(diff)}</td>
            <td><ItemHistoryValue value={diff.local?.sku} /></td>
            <td><ItemHistoryValue value={diff.remote?.sku} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if issue === "quantity"}
    <table class="mini-table">
      <thead>
        <tr>
          <th class="image-column">Image</th>
          <th>Variant</th>
          <th>SKU</th>
          <th>Admin On Hand</th>
          <th>Shopify On Hand</th>
        </tr>
      </thead>
      <tbody>
        {#each variantFieldRows("inventoryQuantity") as diff}
          <tr>
            <td class="image-cell">
              {#if variantImage(diff)}
                <ImageThumbnail
                  src={variantImage(diff)}
                  alt={variantName(diff)}
                  width="44px"
                  height="44px"
                  fit="contain"
                />
              {/if}
            </td>
            <td>{variantName(diff)}</td>
            <td
              ><ItemHistoryValue
                value={diff.local?.sku || diff.remote?.sku}
              /></td
            >
            <td>{displayValue(diff.local?.inventoryQuantity)}</td>
            <td>{displayValue(diff.remote?.inventoryQuantity)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if issue === "variant_image"}
    <table class="mini-table">
      <thead>
        <tr>
          <th class="image-column">Image</th>
          <th>Variant</th>
          <th>SKU</th>
          <th>Admin Image</th>
          <th>Shopify Image</th>
        </tr>
      </thead>
      <tbody>
        {#each variantFieldRows("image") as diff}
          <tr>
            <td class="image-cell">
              {#if variantImage(diff)}
                <ImageThumbnail
                  src={variantImage(diff)}
                  alt={variantName(diff)}
                  width="44px"
                  height="44px"
                  fit="contain"
                />
              {/if}
            </td>
            <td>{variantName(diff)}</td>
            <td
              ><ItemHistoryValue
                value={diff.local?.sku || diff.remote?.sku}
              /></td
            >
            <td>{displayValue(diff.local?.image)}</td>
            <td>{displayValue(diff.remote?.image)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if issue === "gallery"}
    <table class="mini-table">
      <thead>
        <tr>
          <th class="image-column">Preview</th>
          <th>Image #</th>
          <th>Field</th>
          <th>Admin</th>
          <th>Shopify</th>
        </tr>
      </thead>
      <tbody>
        {#each galleryRows() as diff, index}
          {#if diff.fields.length === 0}
            <tr>
              <td class="image-cell">
                {#if galleryImage(diff)}
                  <ImageThumbnail
                    src={galleryImage(diff)}
                    alt={`Gallery ${index + 1}`}
                    width="44px"
                    height="44px"
                    fit="contain"
                  />
                {/if}
              </td>
              <td>#{index + 1}</td>
              <td>presence</td>
              <td>{diff.local ? "present" : "-"}</td>
              <td>{diff.remote ? "present" : "-"}</td>
            </tr>
          {:else}
            {#each diff.fields as field}
              <tr>
                <td class="image-cell">
                  {#if galleryImage(diff)}
                    <ImageThumbnail
                      src={galleryImage(diff)}
                      alt={`Gallery ${index + 1}`}
                      width="44px"
                      height="44px"
                      fit="contain"
                    />
                  {/if}
                </td>
                <td>#{index + 1}</td>
                <td>{fieldLabel(field)}</td>
                <td>{displayValue(diff.local?.[field])}</td>
                <td>{displayValue(diff.remote?.[field])}</td>
              </tr>
            {/each}
          {/if}
        {/each}
      </tbody>
    </table>
  {:else if issue === "status" || issue === "category" || issue === "metadata"}
    <table class="mini-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Admin</th>
          <th>Shopify</th>
        </tr>
      </thead>
      <tbody>
        {#each metadataRowsForIssue() as diff}
          <tr>
            <td>{fieldLabel(diff.key)}</td>
            <td>{displayValue(diff.local)}</td>
            <td>{displayValue(diff.remote)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if issue === "price" || issue === "weight" || issue === "variant_identity" || issue === "single_jan_subtype"}
    <table class="mini-table">
      <thead>
        <tr>
          <th class="image-column">Image</th>
          <th>Variant</th>
          <th>Matched By</th>
          <th>Field</th>
          <th>Admin</th>
          <th>Shopify</th>
        </tr>
      </thead>
      <tbody>
        {#each variantRowsForIssue() as diff}
          {#each variantFieldsForIssue(diff) as field}
            <tr>
              <td class="image-cell">
                {#if variantImage(diff)}
                  <ImageThumbnail
                    src={variantImage(diff)}
                    alt={variantName(diff)}
                    width="44px"
                    height="44px"
                    fit="contain"
                  />
                {/if}
              </td>
              <td>{variantName(diff)}</td>
              <td>{diff.matchType}</td>
              <td>{fieldLabel(field)}</td>
              <td><ItemHistoryValue value={diff.local?.[field]} /></td>
              <td><ItemHistoryValue value={diff.remote?.[field]} /></td>
            </tr>
          {/each}
        {/each}
      </tbody>
    </table>
  {:else if issue === "variant_structure"}
    <table class="mini-table">
      <thead>
        <tr>
          <th class="image-column">Image</th>
          <th>Variant</th>
          <th>Admin</th>
          <th>Shopify</th>
        </tr>
      </thead>
      <tbody>
        {#each variantStructureRows() as diff}
          <tr>
            <td class="image-cell">
              {#if variantImage(diff)}
                <ImageThumbnail
                  src={variantImage(diff)}
                  alt={variantName(diff)}
                  width="44px"
                  height="44px"
                  fit="contain"
                />
              {/if}
            </td>
            <td>{variantName(diff)}</td>
            <td>{diff.local ? "present" : "-"}</td>
            <td>{diff.remote ? "present" : "-"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .issue-detail {
    padding: 0.45rem 0.75rem 0.8rem;
    background: #fcfcfd;
  }

  .mini-table {
    width: 100%;
    min-width: 0;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    border-collapse: separate;
    border-spacing: 0;
    overflow: hidden;
    background: #fff;
  }

  .mini-table th,
  .mini-table td {
    padding: 0.35rem 0.5rem;
    font-size: 0.82rem;
    border-bottom: 1px solid #f3f4f6;
    overflow-wrap: anywhere;
    text-align: left;
    vertical-align: top;
  }

  .mini-table th {
    background: #f9fafb;
    color: #4b5563;
    font-weight: 800;
  }

  .mini-table .image-column,
  .mini-table .image-cell {
    width: 58px;
    min-width: 58px;
    max-width: 58px;
  }

  .mini-table .image-cell {
    padding: 0.25rem 0.4rem;
    vertical-align: middle;
  }

  .mini-table tr:last-child td {
    border-bottom: 0;
  }
</style>
