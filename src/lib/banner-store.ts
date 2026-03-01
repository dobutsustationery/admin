import { writable } from "svelte/store";

export interface BannerDef {
  id: string;
  component: any;
  props: any;
  priority?: number;
}

const { subscribe, update } = writable<BannerDef[]>([]);

export const activeBanners = {
  subscribe,
  register: (def: BannerDef) => {
    update((banners) => {
      const filtered = banners.filter((b) => b.id !== def.id);
      const next = [...filtered, def];
      return next.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    });
  },
  unregister: (id: string) => {
    update((banners) => banners.filter((b) => b.id !== id));
  },
};
