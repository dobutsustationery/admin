<script lang="ts">
  export let current: number;
  export let total: number;
  export let message: string = "";
  export let colorClass: string = "bg-teal-500";
</script>

<div class="px-4 py-2">
    <div class="flex justify-between text-sm text-gray-600 mb-1">
        <span>{message}</span>
        <span>{current} / {total}</span>
    </div>
    <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
        <div class="{colorClass} h-2 rounded-full transition-all duration-300" style="width: {(total > 0 ? current / total : 0) * 100}%"></div>
    </div>
</div>
