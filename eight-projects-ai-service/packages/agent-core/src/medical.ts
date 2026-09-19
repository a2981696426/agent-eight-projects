/**
 * 医疗边界（CS-008B/E：机器人始终禁止医疗建议）。
 * - detectMedicalRequest：识别用户是否在索取用药/剂量/诊断/饮食治疗类建议；紧急症状单独标记
 * - containsMedicalAdvice：守卫模型话术，捕获越界建议
 * - MEDICAL_BOUNDARY_TEXT：固定签发文案，不由模型生成
 */
export const MEDICAL_BOUNDARY_TEXT = '我不能提供用药、剂量、饮食治疗或诊断建议，请咨询医生或药师；如出现意识不清、抽搐、严重低血糖等紧急情况请立即拨打 120。您的设备与订单问题我可以继续帮您处理。';
export const MEDICAL_EMERGENCY_TEXT = '这可能是紧急情况，请立即拨打 120 或前往最近的医院急诊；请勿等待在线回复。我已同步通知专人跟进，设备与订单问题稍后为您继续处理。';

const REQUEST_PATTERNS: RegExp[] = [
  /胰岛素|降糖药|二甲双胍|格列|阿卡波糖|司美格鲁肽|达格列净/,
  /(药量|剂量|用量).{0,6}(多少|怎么|调|加|减|够|行|可以)|加多少药|(加|减|停|换)(药|针)|吃(什么|点)?药|要不要(吃|打|用)/,
  /血糖.{0,6}(高|低|偏高|偏低|太高|太低|飙|掉).{0,10}(怎么办|要不要|该|能不能|吃|喝|打|算)/,
  /(算|是不是|是否|属于).{0,4}糖尿病|诊断|确诊|并发症/,
  /饮食(治疗|方案|控制)|不吃药.{0,6}(控制|行)|靠饮食/,
  /血糖.{0,6}(多少|范围).{0,6}(正常|算)|正常(值|范围)/,
  /(喝|吃).{0,6}(可乐|糖水|糖).{0,4}(行不行|可以吗|能不能)/,
  /要去医院吗|需要去医院|去不去医院/,
  /血糖.{0,10}(要|该|能|应该).{0,4}(吃|喝|打|用)|吃点什么|喝点什么/,
];
const DRUGS = '二甲双胍|格列|胰岛素|降糖药|阿卡波糖|司美格鲁肽|达格列净|降糖';
const EMERGENCY_PATTERNS = /昏迷|意识不清|神志不清|抽搐|晕倒|昏倒|叫不醒|不省人事|严重低血糖|休克|呼吸困难/;

export function detectMedicalRequest(text: string): { medical: boolean; emergency: boolean; hits: string[] } {
  const s = text.replace(/\s+/g, '');
  const hits = REQUEST_PATTERNS.map((re) => s.match(re)?.[0]).filter((x): x is string => !!x);
  const emergency = EMERGENCY_PATTERNS.test(s);
  return { medical: hits.length > 0 || emergency, emergency, hits: emergency ? [...hits, s.match(EMERGENCY_PATTERNS)![0]] : hits };
}

const ADVICE_PATTERNS: RegExp[] = [
  /(建议|可以|应该|需要|请).{0,6}(服用|加|减|停|调整|换|打).{0,8}(药|胰岛素|剂量|针)/,
  new RegExp(`(建议|可以|应该|需要|请|试试).{0,6}(服用|吃|用|打|换成|改用).{0,8}(${DRUGS})`),
  /(剂量|药量|用量).{0,6}(调|加|减|改).{0,8}(单位|mg|毫克|片|次)/,
  /每天.{0,6}(单位|mg|毫克|片).{0,4}(胰岛素|药)/,
  /(先|可以)?(停药|减药|加药)(观察|试试|看看)?/,
  /(诊断为|属于|确诊|是)(1型|2型|二型|一型)?糖尿病/,
  /饮食治疗/,
  /(建议|应该).{0,6}(少吃|多吃|禁食|不吃).{0,10}(降|控制|血糖)/,
];

export function containsMedicalAdvice(text: string): { advice: boolean; hits: string[] } {
  const s = text.replace(/\s+/g, '');
  // 边界文案本身包含"用药、剂量"等词但为否定句式，先排除
  const stripped = s.replace(MEDICAL_BOUNDARY_TEXT.replace(/\s+/g, ''), '').replace(MEDICAL_EMERGENCY_TEXT.replace(/\s+/g, ''), '');
  const hits = ADVICE_PATTERNS.map((re) => stripped.match(re)?.[0]).filter((x): x is string => !!x);
  return { advice: hits.length > 0, hits };
}
