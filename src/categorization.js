import { CATEGORIES, INCOME_CATEGORIES, categoryById, normalizeText } from './model.js';

const sourceCategories = [
  [/餐饮|美食|餐廳/, 'food'],
  [/教育|培训|学习/, 'learning'],
  [/文化休闲|娱乐/, 'entertainment'],
  [/医疗|健康/, 'health'],
  [/交通|出行/, 'transport'],
  [/充值缴费|通讯|通信/, 'communication'],
  [/服饰|装扮|数码电器|购物|日用百货/, 'shopping'],
  [/酒店|旅游/, 'other'],
  [/生活服务/, 'other'],
  [/退款|账户存取|信用借还|不计收支/, 'other']
];

// Specific payee patterns take priority over broad provider categories.
const merchantRules = [
  { pattern: /华莱士|肯德基|麦当劳|汉堡王|必胜客|德克士|塔斯汀|炸鸡|汉堡|烤肉|火锅|鳝鱼|炒饭|炒面|餐厅|饭店|快餐|面馆|小吃|奶茶|咖啡|瑞幸|星巴克|喜茶|茶百道|蜜雪冰城|水果店|鲜果|菜市场|生鲜|超市/, category: 'food', reason: '餐饮与食品商户' },
  { pattern: /学校|学院|大学|职业技术学院|职业学校|中学|小学|幼儿园/, category: 'food', reason: '按你的偏好，学校类商户归入吃喝' },
  { pattern: /中国移动|中国联通|中国电信|移动通信|联通通信|电信通信|话费|流量包|宽带缴费/, category: 'communication', reason: '通信运营商或通信缴费' },
  { pattern: /滴滴|高德打车|曹操出行|铁路12306|火车票|地铁|公交|交通卡|停车费|停车场|加油站|中石化|中石油|航空|机票|客运站/, category: 'transport', reason: '交通与出行服务' },
  { pattern: /房租|租金|物业费|水费|电费|燃气费|天然气|供暖费/, category: 'home', reason: '住房与公共事业缴费' },
  { pattern: /医院|门诊|药房|药店|药品|医疗|挂号|体检|诊所/, category: 'health', reason: '医疗健康服务' },
  { pattern: /学费|培训|课程|教材|图书|文具|打印店/, category: 'learning', reason: '教育与学习服务' },
  { pattern: /腾讯视频|爱奇艺|优酷|哔哩哔哩大会员|网易云音乐|QQ音乐|会员|连续包月|自动续费|订阅/, category: 'subscription', reason: '会员与订阅服务' },
  { pattern: /电影院|电影票|网吧|游戏|steam|游乐|剧院|演出|文娱|文化休闲/, category: 'entertainment', reason: '娱乐与文化消费' },
  { pattern: /红包|礼物|随礼|份子钱/, category: 'people', reason: '红包与人情往来' },
  { pattern: /淘宝|天猫|京东|拼多多|闲鱼|抖音电商|唯品会|苏宁|服装|鞋店|数码|电子产品|百货/, category: 'shopping', reason: '零售与网购' }
];

const commonSurnames = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳唐罗薛伍余米贝姚孟顾尹江钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫房裘缪干应宗丁宣邓郁杭洪包诸左石崔吉龚程邢裴陆荣荀羊惠甄加封芮靳汲松段富巫焦巴牧山谷车侯全班仰秋仲伊宫宁仇甘祖武符刘景詹束龙叶司黎白怀蒲卓蔺屠乔阴胥双翟谭贡姬申扶堵冉宰桑桂濮牛寿边扈燕浦尚农温庄晏柴瞿阎充慕连茹习艾鱼向古易慎戈廖庚居衡步都耿满匡文寇广聂晁敖融冷辛简饶曾养鞠丰关相查荆红游竺权盖桓公';
const nonPersonShortNames = new Set(['武汉', '北京', '上海', '南京', '深圳', '广州', '杭州', '成都', '苏州', '天津', '重庆', '西安', '长沙', '郑州', '青岛']);

function isLikelyPersonMerchant(value) {
  const raw = String(value || '').trim();
  if (!raw || /学校|学院|大学|公司|商店|超市|医院|银行|中心|门店|旗舰|科技|餐饮/.test(raw)) return false;
  if (/^[A-Z][a-z]{1,7}[A-Z][a-z]{1,7}$/.test(raw)) return true;
  const han = raw.replace(/\s/g, '');
  return /^[\u4e00-\u9fff]{2,3}$/u.test(han) && !nonPersonShortNames.has(han) && commonSurnames.includes(han[0]);
}

const incomeRules = [
  { pattern: /工资|薪酬|薪资|劳务|兼职|稿费|奖金/, category: 'income_salary', reason: '工资与劳务收入' },
  { pattern: /退款|退货|退还|返还|冲正/, category: 'income_refund', reason: '退款或资金返还' },
  { pattern: /红包|转账红包|礼金/, category: 'income_gift', reason: '红包与人情收入' },
  { pattern: /利息|分红|理财收益|投资收益/, category: 'income_investment', reason: '利息或投资收益' }
];

export function classifyTransaction({ merchant = '', rawType = '', details = '', direction = 'expense', learnedRules = [] } = {}) {
  const payee = normalizeText(merchant);
  const sourceType = normalizeText(rawType);
  const detailText = normalizeText(details);
  const fullText = `${payee} ${sourceType} ${detailText}`;

  if (direction === 'transfer' || direction === 'excluded') {
    return { category: 'other', confidence: 1, categorySource: 'system', categoryReason: direction === 'transfer' ? '明确的内部转账，不计收入或支出' : '账单标记为不计收支' };
  }

  const learned = [...learnedRules].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).find(rule => {
    const key = normalizeText(rule.merchant || rule.match || '');
    return key && (!rule.direction || rule.direction === direction) && payee.includes(key);
  });
  if (learned && categoryById(learned.category)) {
    return { category: learned.category, confidence: 1, categorySource: 'personal-rule', categoryReason: '沿用你保存的商户分类规则' };
  }

  if (direction === 'income') {
    const incomeRule = incomeRules.find(rule => rule.pattern.test(fullText));
    if (incomeRule) return { category: incomeRule.category, confidence: 0.96, categorySource: 'rule', categoryReason: incomeRule.reason };
    const telecom = merchantRules.find(rule => rule.category === 'communication' && rule.pattern.test(fullText));
    if (telecom) return { category: telecom.category, confidence: 0.94, categorySource: 'merchant', categoryReason: telecom.reason };
    return { category: 'income_other', confidence: 0.68, categorySource: 'direction', categoryReason: '收入方向已识别，收入来源待细分' };
  }

  const merchantRule = merchantRules.find(rule => rule.pattern.test(fullText));
  if (merchantRule) return { category: merchantRule.category, confidence: 0.97, categorySource: 'merchant', categoryReason: merchantRule.reason };

  if (isLikelyPersonMerchant(merchant)) {
    return { category: 'food', confidence: 0.84, categorySource: 'person-name', categoryReason: '按你的偏好，个人姓名类商户归入吃喝' };
  }

  const sourceRule = sourceCategories.find(([pattern]) => pattern.test(rawType));
  if (sourceRule && sourceRule[1] !== 'other') {
    return { category: sourceRule[1], confidence: 0.86, categorySource: 'provider', categoryReason: `依据账单分类“${rawType}”` };
  }

  if (/外卖|点餐|美团|饿了么/.test(fullText)) return { category: 'food', confidence: 0.82, categorySource: 'keyword', categoryReason: '餐饮关键词' };
  if (/购物|网购|快递|电商/.test(fullText)) return { category: 'shopping', confidence: 0.76, categorySource: 'keyword', categoryReason: '零售关键词' };
  return { category: direction === 'income' ? INCOME_CATEGORIES.at(-1).id : CATEGORIES.at(-1).id, confidence: 0.28, categorySource: 'fallback', categoryReason: '商户与账单分类信息不足，建议确认' };
}

export function transactionCategories(direction) {
  if (direction === 'income') {
    // Communication providers sometimes issue a cash refund/top-up reversal;
    // keep the merchant's domain visible without pretending it was wages.
    return [...INCOME_CATEGORIES, CATEGORIES.find(category => category.id === 'communication')];
  }
  return CATEGORIES;
}
