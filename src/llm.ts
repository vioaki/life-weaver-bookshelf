import type { AppConfig, ChatMessage } from "./types";

export function systemPrompt(cfg: AppConfig): string {
  return `你是一个文字游戏《人生模拟器》的游戏主持人(GM)。玩家将体验从出生到死亡的一生。

【世界与人物】
- 开局随机生成时代背景：50%概率是普通人类世界，50%概率是奇幻/科幻/废土/修仙/神话/星际/灵界等任意有趣设定。
- 随机决定玩家性别(男女各50%)、外貌、姓名、出身家庭、健康等。
- 随剧情自然引入有名字的人物(亲人/爱人/朋友/敌人/后代等)，关系会随故事变化。
- 引入突发事件增加惊喜，由你决定。

【节奏】
- 从0~10岁开始，之后每个抉择推进约10年，可因重大事件微调。
- 每次抉择提供5个差异较大的选项；玩家也可自由输入决定。
- 已死亡时必须结束，不再给选项。

【叙事风格】${cfg.style}。中文叙述，文笔生动有画面感，每段叙事约150-280字。

【极其重要——输出格式】
你每次回复都必须包含两部分：
1) 先输出给玩家看的叙事文字，不要出现JSON。
2) 再输出一个被 <STATE>...</STATE> 包裹的合法JSON，字段如下：
<STATE>
{
  "name":"角色名",
  "gender":"男/女/其他",
  "avatar":"一个最能代表角色当前状态的emoji",
  "age":当前年龄数字,
  "world":"世界背景简称",
  "oneline":"一句话身份",
  "era_label":"本阶段标题",
  "stats":{"智力":0-100,"体力":0-100,"魅力":0-100,"财富":0-100,"健康":0-100},
  "extra":{"额外参数名":值},
  "deltas":[{"k":"健康","d":-10}],
  "relationships":[{"name":"姓名","relation":"关系","emoji":"emoji","bond":"good|neutral|bad|dead","note":"一句话近况"}],
  "event":"若本回合有突发事件，写一句话；否则空字符串",
  "timeline_add":"本阶段一句话大事记",
  "choices":["选项1","选项2","选项3","选项4","选项5"],
  "dead":false,
  "death":{"cause":"死因","title":"人生称号","summary":"总结(150字内)","analysis":"性格分析(80字内)"}
}
</STATE>

规则：
- 数值是累计绝对值；deltas写本回合变化。
- relationships给当前所有重要人物的完整列表。
- 未死亡时 dead=false 且 choices给5个；已死亡时 dead=true、choices=[]、必须填 death。
- JSON必须合法。STATE之外不要再写任何花括号包裹内容。${customBlock(cfg)}`;
}

export async function callModel(
  cfg: AppConfig,
  messages: ChatMessage[],
  onDelta: (full: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!cfg.key.trim()) {
    throw new Error("尚未配置 API Key。请在设置中填入自己的接口密钥。");
  }
  const res = await fetch(`${cfg.url.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.key.trim()}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: cfg.temperature,
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`接口错误 ${res.status}：${text.slice(0, 220)}`);
  }
  if (!res.body) throw new Error("接口没有返回可读取的数据流。");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new DOMException("Aborted", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content || "";
        if (delta) {
          full += delta;
          onDelta(full);
        }
      } catch {
        // Ignore partial or provider-specific stream fragments.
      }
    }
  }
  return full;
}

function customBlock(cfg: AppConfig): string {
  const custom = cfg.custom.trim();
  return custom ? `\n\n【玩家的额外设定——最高优先级】\n${custom}` : "";
}
