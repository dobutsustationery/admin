<script lang="ts">
  import { page } from "$app/stores";
  import { user } from "$lib/globals";

  import {
    LayoutDashboard,
    PlusCircle,
    List,
    Package,
    Grid,
    CreditCard,
    Download,
    Tag,
    Archive
  } from "lucide-svelte";

  export let unsyncedActions = 0;
  export let isOpen = false;

  const links = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/entry", label: "Add Inventory", icon: PlusCircle },
    { href: "/inventory", label: "View Inventory", icon: List },
    { href: "/orders", label: "Orders", icon: Package },
    { href: "/subtypes", label: "Subtypes", icon: Grid },
    { href: "/payments", label: "Payments", icon: CreditCard },
    { href: "/csv", label: "Export CSV", icon: Download },
    { href: "/names", label: "Manage Names", icon: Tag },
    { href: "/archives", label: "Archives", icon: Archive },
  ];

  function toggleMenu() {
    isOpen = !isOpen;
  }
</script>

<nav class:open={isOpen}>
  <div class="nav-header">
    <div class="brand">Dobutsu Admin</div>
    <button class="menu-toggle" on:click={toggleMenu} aria-label="Toggle Navigation">
      ☰
    </button>
  </div>

  <div class="nav-content">
    <ul class="nav-links">
      {#each links as link}
        <li class:active={$page.url.pathname === link.href}>
          <a href={link.href} on:click={() => (isOpen = false)}>
            <span class="icon">
              <svelte:component this={link.icon} size={20} />
            </span>
            <span class="label">{link.label}</span>
          </a>
        </li>
      {/each}
    </ul>

    <div class="nav-footer">
      {#if $user}
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

  .nav-links a {
    display: flex;
    align-items: center;
    padding: 1rem;
    text-decoration: none;
    color: #333;
    transition: background-color 0.2s;
  }

  .nav-links a:hover {
    background-color: #e9ecef;
  }

  .nav-links li.active a {
    background-color: #e7f1ff;
    color: #0056b3;
    font-weight: 500;
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

  /* Mobile Styles */
  @media (max-width: 768px) {
    nav {
      transform: translateX(-100%);
      width: 80%; /* Drawer width */
    }

    nav.open {
      transform: translateX(0);
    }

    .menu-toggle {
      display: block; /* Show toggle inside drawer (or handle externally) */
    }
    
    /* We need an external toggle for mobile when closed, handled by Layout usually */
  }
</style>
