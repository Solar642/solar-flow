const AUTH_ERROR_MESSAGES = {
  'auth/invalid-email': '邮箱地址格式不正确。',
  'auth/email-already-in-use': '这个邮箱已经注册，请直接登录。',
  'auth/invalid-credential': '邮箱或密码不正确。',
  'auth/user-not-found': '没有找到这个邮箱对应的账号。',
  'auth/weak-password': '密码强度不足，请换一个更长的密码。',
  'auth/too-many-requests': '尝试次数过多，请稍后再试。',
  'auth/network-request-failed': '连接不到 Firebase 账号服务（网络中断或当前网络无法访问）。请切换 Wi-Fi/蜂窝网络后重试；本机账本不会丢失。',
  'auth/timeout': 'Firebase 登录请求超时。请切换网络后重试；本机账本不会丢失。',
  'auth/unauthorized-domain': '当前网站域名未加入 Firebase 授权列表，请检查 Authentication 的授权域名。',
  'auth/invalid-api-key': 'Firebase 客户端配置无效，请联系 Solar Flow 管理者检查部署配置。',
  'auth/app-not-authorized': 'Firebase 尚未授权此网站使用账号服务，请检查项目配置。',
  'auth/operation-not-allowed': 'Firebase 尚未启用邮箱和密码登录。'
};

export function messageForAuthError(error) {
  return AUTH_ERROR_MESSAGES[error?.code] || error?.message || '账号操作失败，请稍后重试。';
}
