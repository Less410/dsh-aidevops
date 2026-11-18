export type DeliveryServerOption = {
  id: string;
  name: string;
  host: string;
};

/**
 * 发布目标服务器解析：显式指定 > 仓库绑定的服务器 > 第一台。
 * 仓库绑定失效时直接报错，避免把项目发到别的服务器。
 */
export function resolveDeliveryServer(
  servers: DeliveryServerOption[],
  options: { requested?: string; preferredServerId?: string | null },
): DeliveryServerOption {
  if (servers.length === 0) {
    throw new Error("平台还没有登记任何服务器，请先在“云服务器”中接入。");
  }
  const requested = options.requested?.trim() ?? "";
  if (requested) {
    const matched = servers.find(
      (server) =>
        server.id === requested ||
        server.name === requested ||
        server.host === requested,
    );
    if (!matched) {
      throw new Error(
        `服务器不存在：${requested}。已登记：${servers
          .map((server) => `${server.name}（${server.host}）`)
          .join("、")}`,
      );
    }
    return matched;
  }
  const preferredServerId = options.preferredServerId ?? "";
  if (preferredServerId) {
    const preferred = servers.find((server) => server.id === preferredServerId);
    if (!preferred) {
      throw new Error(
        "仓库绑定的服务器已不存在，请先在“代码仓库”中重新选择发布服务器。",
      );
    }
    return preferred;
  }
  const fallback = servers[0];
  if (!fallback) {
    throw new Error("平台还没有登记任何服务器，请先在“云服务器”中接入。");
  }
  return fallback;
}
