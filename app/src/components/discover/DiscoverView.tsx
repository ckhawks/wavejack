import { useDiscoverStore } from "../../stores/discoverStore";
import { SeedPicker } from "./SeedPicker";
import { DiscoverPlayer } from "./DiscoverPlayer";

export function DiscoverView() {
  const hasQueue = useDiscoverStore((s) => s.queue.length > 0);

  return hasQueue ? <DiscoverPlayer /> : <SeedPicker />;
}
