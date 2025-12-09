<script lang="ts">
  import { store } from "$lib/store";

  // Dashboard Metrics
  $: totalItems = $store.inventory ? Object.keys($store.inventory.items || {}).length : 0;
  // Calculate total quantity roughly (sum of all quantities)
  $: totalQuantity = $store.inventory ? Object.values($store.inventory.items || {}).reduce((acc: number, item: any) => acc + (item.quantity || 0), 0) : 0;
  
  // Recent activity mock
  let recentActivity = [
    { type: "order", text: "Order #1234 packed", time: "5m ago" },
    { type: "inventory", text: "Added 50 pens", time: "1h ago" }
  ];
</script>

<div class="dashboard">
  <h1>Dashboard</h1>
  
  <div class="metrics-grid">
    <div class="card metric">
      <div class="metric-value">{totalItems}</div>
      <div class="metric-label">Total SKUs</div>
    </div>
    <div class="card metric">
      <div class="metric-value">{totalQuantity}</div>
      <div class="metric-label">Total Items</div>
    </div>
    <div class="card metric">
      <div class="metric-value">--</div>
      <div class="metric-label">Shipped Today</div>
    </div>
    <div class="card metric">
      <div class="metric-value">--</div>
      <div class="metric-label">Low Stock</div>
    </div>
  </div>

  <div class="quick-actions">
    <h2>Quick Actions</h2>
    <div class="actions-grid">
      <a href="/scanner" class="card action">
        <span class="icon">➕</span>
        Add Inventory
      </a>
      <a href="/inventory" class="card action">
        <span class="icon">📋</span>
        View Inventory
      </a>
      <a href="/orders" class="card action">
        <span class="icon">📦</span>
        Process Orders
      </a>
      <a href="/csv" class="card action">
        <span class="icon">⬇️</span>
        Export CSV
      </a>
    </div>
  </div>

  <div class="recent-activity">
    <h2>Recent Activity</h2>
    <div class="card activity-list">
      {#each recentActivity as activity}
        <div class="activity-item">
          <span class="activity-icon">{activity.type === 'order' ? '📦' : '📝'}</span>
          <div class="activity-details">
            <span class="activity-text">{activity.text}</span>
            <span class="activity-time">{activity.time}</span>
          </div>
        </div>
      {/each}
      <div class="activity-placeholder">
        (Real activity feed coming soon)
      </div>
    </div>
  </div>
</div>

<style>
  .dashboard {
    max-width: 1200px;
    margin: 0 auto;
  }

  h1 {
    font-size: 2rem;
    margin-bottom: 2rem;
    color: #333;
  }

  h2 {
    font-size: 1.5rem;
    margin-bottom: 1rem;
    color: #555;
    margin-top: 2rem;
  }

  .card {
    background: white;
    border-radius: 8px;
    padding: 1.5rem;
    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    border: 1px solid #eee;
    text-decoration: none; /* Ensure links look like cards */
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1.5rem;
  }

  .metric {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .metric-value {
    font-size: 2.5rem;
    font-weight: bold;
    color: var(--primary-color, #0056b3);
  }

  .metric-label {
    color: #666;
    margin-top: 0.5rem;
  }

  .actions-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1.5rem;
  }

  .action {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    color: inherit;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .action:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(0,0,0,0.1);
    background-color: #f8f9fa;
  }

  .action .icon {
    font-size: 2rem;
    margin-bottom: 0.5rem;
  }

  .activity-list {
    padding: 0;
  }

  .activity-item {
    display: flex;
    align-items: center;
    padding: 1rem;
    border-bottom: 1px solid #eee;
  }

  .activity-item:last-child {
    border-bottom: none;
  }

  .activity-icon {
    font-size: 1.5rem;
    margin-right: 1rem;
  }

  .activity-details {
    display: flex;
    flex-direction: column;
  }

  .activity-text {
    font-weight: 500;
  }

  .activity-time {
    font-size: 0.8rem;
    color: #999;
  }
  
  .activity-placeholder {
     padding: 1rem;
     text-align: center;
     font-style: italic;
     color: #999;
  }
</style>
