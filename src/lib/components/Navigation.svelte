<script lang="ts">
  import { page } from "$app/stores";
  import { user } from "$lib/globals";

  import {
    Home,
    PlusCircle,
    ClipboardList,
    Package,
    Grid,
    CreditCard,
    Download,
    Tag,
    Archive,
    User,
    History,
    Barcode,
    Import,
    Image,
    Camera,
    ShoppingBag,
    Tv,
    CheckSquare,
    FileEdit,
    Bug,
    Split,
    Wrench,
    ChevronDown,
  } from "lucide-svelte";

  export let unsyncedActions = 0;
  export let isOpen = false;

  const links = [
    { href: "/", label: "Dashboard", icon: Home },
    { href: "/inventory", label: "Inventory", icon: ClipboardList },
    { href: "/orders", label: "Customer Orders", icon: Package },
    { href: "/customs-summary", label: "Customs Summary", icon: ClipboardList },
    { href: "/order-receipt", label: "Receive Order", icon: Package },
    { href: "/live-event-import", label: "Live Event Import", icon: Import },
    { href: "/listings/create", label: "Create Listings", icon: FileEdit },
    { href: "/photos", label: "Photos", icon: Camera },
    { href: "/shopify-products", label: "Product Catalog", icon: ShoppingBag },
    { href: "/shopify-listings", label: "Shopify Listings", icon: ShoppingBag },
    { href: "/amazon-listings", label: "Amazon Listings", icon: ShoppingBag },
    { href: "/inventory-value", label: "Inventory Value", icon: CreditCard },
    { href: "/sync-status", label: "Sync Status", icon: History },
    { href: "/account", label: "Account", icon: User },
  ];
  let groups = [
    {
      label: "Tools",
      icon: Wrench,
      open: false,
      links: [
        { href: "/subtypes", label: "Subtypes", icon: Grid },
        {
          href: "/subtype-exceptions",
          label: "Subtype Exceptions",
          icon: Split,
        },
        { href: "/csv", label: "Export CSV", icon: Download },
        { href: "/names", label: "Saved Names and Codes", icon: Tag },
        { href: "/itemhistory", label: "Item History", icon: History },
        { href: "/sku-review", label: "SKU Review", icon: CheckSquare },
        { href: "/photo-history", label: "Photo History", icon: Image },
        { href: "/order-exceptions", label: "Order Exceptions", icon: Import },
        { href: "/unpriced", label: "Cost Issues", icon: ClipboardList },
        { href: "/audit", label: "Audit Log", icon: ClipboardList },
        { href: "/devtools", label: "DevTools", icon: Bug },
      ],
    },
    {
      label: "Obsolete",
      icon: Archive,
      open: false,
      links: [
        { href: "/order-import", label: "Supplier CSV Import", icon: Import },
        {
          href: "/scanner",
          label: "Direct Stock Entry / Scanner",
          icon: PlusCircle,
        },
        { href: "/shopify-import", label: "Shopify CSV Import", icon: Import },
        { href: "/archives", label: "Archives", icon: Archive },
        { href: "/shows", label: "Archive-based Event Sales", icon: Tv },
        {
          href: "/payments",
          label: "PayPal Payment History",
          icon: CreditCard,
        },
        { href: "/jancodes", label: "Blank-subtype Editor", icon: Barcode },
        { href: "/test-edit", label: "Image Edit Testbed", icon: FileEdit },
      ],
    },
  ];
  const detailParents: Record<string, string> = {
    "/order": "/orders",
    "/listing-detail": "/shopify-products",
    "/cost-ledger-editor": "/unpriced",
    "/rekeyitem": "/inventory",
  };
  $: pathname = $page.url.pathname.replace(/\/+$/, "") || "/";
  function isActive(href: string, path: string) {
    return (
      path === href ||
      detailParents[path] === href ||
      (href !== "/" && path.startsWith(href + "/"))
    );
  }
  let lastPath = "";
  $: if (pathname !== lastPath) {
    groups = groups.map((group) => ({
      ...group,
      open: group.links.some((link) => isActive(link.href, pathname)),
    }));
    lastPath = pathname;
  }

  function toggleMenu() {
    isOpen = !isOpen;
  }
</script>

{#if !isOpen}
  <button
    class="mobile-open"
    on:click={toggleMenu}
    aria-label="Open navigation"
    aria-expanded={isOpen}
    aria-controls="main-navigation">☰</button
  >
{/if}
<nav id="main-navigation" class:open={isOpen} aria-label="Main navigation">
  <div class="nav-header">
    <div class="brand">Dobutsu Admin</div>
    <button
      class="menu-toggle"
      on:click={toggleMenu}
      aria-label="Close navigation"
      aria-expanded={isOpen}
      aria-controls="main-navigation"
    >
      ☰
    </button>
  </div>

  <div class="nav-content">
    <ul class="nav-links">
      {#each links as link}
        <li class:active={isActive(link.href, pathname)}>
          <a
            href={link.href}
            aria-current={isActive(link.href, pathname) ? "page" : undefined}
            on:click={() => (isOpen = false)}
          >
            <span class="icon">
              <svelte:component this={link.icon} size={20} />
            </span>
            <span class="label">{link.label}</span>
          </a>
        </li>
      {/each}
      {#each groups as group (group.label)}
        <li>
          <details
            class="nav-group"
            class:active={group.links.some((link) =>
              isActive(link.href, pathname),
            )}
            bind:open={group.open}
          >
            <summary>
              <span class="icon"
                ><svelte:component this={group.icon} size={20} /></span
              >
              <span class="label">{group.label}</span>
              <span class="chevron"><ChevronDown size={16} /></span>
            </summary>
            <ul class="group-links">
              {#each group.links as link}
                <li class:active={isActive(link.href, pathname)}>
                  <a
                    href={link.href}
                    aria-current={isActive(link.href, pathname)
                      ? "page"
                      : undefined}
                    on:click={() => (isOpen = false)}
                  >
                    <span class="icon"
                      ><svelte:component this={link.icon} size={18} /></span
                    >
                    <span class="label">{link.label}</span>
                  </a>
                </li>
              {/each}
            </ul>
          </details>
        </li>
      {/each}
    </ul>

    <div class="nav-footer">
      {#if $user?.signedIn}
        <div class="user-info">
          <img src={$user.photo} alt={$user.name} class="avatar" />
          <span class="username">{$user.name}</span>
        </div>
      {/if}
      <div class="sync-status">
        Sync: {unsyncedActions}
      </div>
    </div>
  </div>
</nav>

<style>
  nav {
    display: flex;
    flex-direction: column;
    width: 250px;
    background-color: #f8f9fa;
    border-right: 1px solid #dee2e6;
    height: 100vh;
    position: fixed;
    left: 0;
    top: 0;
    z-index: 100;
    transition: transform 0.3s ease-in-out;
  }

  .nav-header {
    padding: 1rem;
    border-bottom: 1px solid #dee2e6;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .brand {
    font-weight: bold;
    font-size: 1.2rem;
  }

  .mobile-open,
  .menu-toggle {
    display: none;
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
  }

  .nav-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow-y: auto;
  }

  .nav-links {
    list-style: none;
    padding: 0;
    margin: 0;
    flex: 1;
  }

  .nav-links li {
    border-bottom: 1px solid #eee;
  }

  .nav-links a,
  summary {
    display: flex;
    align-items: center;
    padding: 1rem;
    text-decoration: none;
    color: #333;
    transition: background-color 0.2s;
  }

  .nav-links a:hover,
  summary:hover {
    background-color: #e9ecef;
  }

  .nav-links li.active > a,
  .nav-group.active > summary {
    background-color: #e7f1ff;
    color: #0056b3;
    font-weight: 500;
  }

  summary {
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .group-links {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .group-links a {
    padding: 0.75rem 1rem 0.75rem 1.75rem;
    font-size: 0.9rem;
  }
  .group-links li:last-child {
    border-bottom: 0;
  }
  .chevron {
    margin-left: auto;
    display: flex;
  }
  .nav-group[open] > summary .chevron {
    transform: rotate(180deg);
  }
  a:focus-visible,
  summary:focus-visible,
  button:focus-visible {
    outline: 2px solid #0056b3;
    outline-offset: -3px;
  }
  .icon {
    margin-right: 0.75rem;
    display: flex;
    align-items: center;
  }

  .nav-footer {
    padding: 1rem;
    border-top: 1px solid #dee2e6;
    background-color: #f1f3f5;
  }

  .user-info {
    display: flex;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    margin-right: 0.5rem;
  }

  .username {
    font-size: 0.9rem;
    font-weight: 500;
  }

  .sync-status {
    font-size: 0.8rem;
    color: #666;
  }

  .mobile-open {
    position: fixed;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 99;
    background: #f8f9fa;
    color: #333;
    border: 1px solid #dee2e6;
    border-radius: 6px;
    min-width: 44px;
    min-height: 44px;
    cursor: pointer;
  }
  /* Mobile Styles */
  @media (max-width: 768px) {
    nav {
      transform: translateX(-100%);
      width: 80%; /* Drawer width */
    }

    nav.open {
      transform: translateX(0);
    }

    .mobile-open,
    .menu-toggle {
      display: block; /* Show toggle inside drawer (or handle externally) */
    }
  }
</style>
