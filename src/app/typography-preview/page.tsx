/**
 * 排版预览页 —— 用**真实模型输出**渲染，供人眼核对效果
 *
 * ★ 为什么需要它：
 *   排版是**视觉问题**，测试断言不了「看着舒不舒服」。唯一可靠的
 *   验收方式是**看**。
 *
 *   ⚠️ 而且必须用**真实模型输出**，不能用编造的整齐文本 ——
 *      编出来的例子永远比真实输出干净，而真实输出才有那些
 *      长短不齐的行、混在一起的标题与正文、多余的空行。
 *
 * ⚠️ 开发用的样张页：不进导航、不对外。留着是因为以后调排版会
 *    反复用到 —— 改一处 CSS 就要重新看一遍。
 */

import { describeClassification, classifyLines } from '@/app/typography';
import { RichContent } from '@/app/rich-content';

export const dynamic = 'force-static';

/** 实测一次「周末请朋友吃饭」对话的真实产出。 */
const REAL_MENU = `未发现冲突。life 提供的两人家宴菜单与 health 的营养用量核对在菜式、份量、食材上完全一致，health 仅补充了用油与钠的量化建议（属优化提示，非矛盾）。无全局硬约束，无跨仆人冲突。

两人周末家宴方案（在家做）

【菜式方向】两人份、四菜一汤+一主食，全部家常可操作，单道菜30分钟内可完成，避免长时间炖煮或专业设备。

【菜单】
1. 蒜蓉粉丝蒸虾（主菜·海鲜）—— 鲜虾400g、龙口粉丝1小把、蒜1头、小米辣2根、蒸鱼豉油2勺
2. 黑椒牛柳（主菜·肉）—— 牛里脊300g、洋葱半个、彩椒1个、黑胡椒碎、蚝油、生抽、淀粉
3. 清炒时蔬（素）—— 西兰花1颗或芦笋300g、蒜2瓣
4. 凉拌木耳黄瓜（凉菜·可提前做）—— 干木耳15g、黄瓜1根、香醋、香油、蒜末
5. 番茄豆腐蛋汤（汤）—— 番茄2个、嫩豆腐1盒、鸡蛋2个
6. 主食：米饭（2人约1.5杯米）或现成馒头4个

【食材清单（按采购单位）】
生鲜：鲜虾400g、牛里脊300g、鸡蛋4个、嫩豆腐1盒、番茄2个、黄瓜1根、洋葱半个、彩椒1个、西兰花1颗、蒜2头、小米辣2根、姜1块、葱2根
干货调料：龙口粉丝1把、干木耳15g、黑胡椒碎、蚝油、生抽、蒸鱼豉油、香醋、香油、淀粉、食用油、盐、糖

【能量估算】
约 1800 千卡/两人，蛋白质约 95g；建议减脂期控制在 700 千卡/人以内。

---
**注意**：木耳要提前泡发，粉丝用温水泡软即可，不要泡过头。`;

export default function TypographyPreviewPage() {
  return (
    <div className="shell">
      <main className="main">
        <div className="content">
          <h1>排版效果预览</h1>
          <div className="page-sub">真实模型输出（一次「周末请朋友吃饭」对话的产出）</div>

          <h2>渲染效果</h2>
          <RichContent text={REAL_MENU} />

          <h2 style={{ marginTop: 48 }}>分类判定（人工核对用）</h2>
          <div className="page-sub" style={{ marginBottom: 12 }}>
            █ = 标粗标大 · ▓ = 只标粗 · • = 列表
          </div>
          <pre
            className="mono"
            style={{
              background: 'var(--bg-subtle)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              padding: '14px 16px',
              fontSize: 12,
              lineHeight: 1.8,
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {describeClassification(classifyLines(REAL_MENU))}
          </pre>
        </div>
      </main>
    </div>
  );
}
