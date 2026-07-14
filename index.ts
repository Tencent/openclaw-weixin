import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

import { setDurableQueueAdmissionSupported, weixinPlugin } from "./src/channel.js";
import { assertHostCompatibility, supportsDurableQueueAdmission } from "./src/compat.js";
import { WeixinConfigSchema } from "./src/config/config-schema.js";

export default {
  id: "openclaw-weixin",
  name: "Weixin",
  description: "Weixin channel (getUpdates long-poll + sendMessage)",
  configSchema: buildChannelConfigSchema(WeixinConfigSchema),
  register(api: OpenClawPluginApi) {
    // Fail-fast: reject incompatible host versions before any side-effects.
    const hostVersion = api.runtime?.version;
    assertHostCompatibility(hostVersion);
    setDurableQueueAdmissionSupported(supportsDurableQueueAdmission(hostVersion));

    api.registerChannel({ plugin: weixinPlugin });
  },
};
