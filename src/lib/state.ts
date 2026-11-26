/**
 * Anti-API 全局状态管理
 * 存储运行时配置和token信息
 */

export interface State {
    // Antigravity认证token (Google OAuth2)
    antigravityToken: string | null
    accessToken: string | null  // 别名，用于 OAuth
    // Refresh Token (用于云端 API)
    refreshToken: string | null
    // Token 过期时间 (毫秒时间戳)
    tokenExpiresAt: number | null
    // 用户信息
    userEmail: string | null
    userName: string | null
    // 服务器配置
    port: number
    verbose: boolean
    // 动态获取的CloudAICompanion项目ID
    cloudaicompanionProject: string | null
    // Cascade 会话ID
    cascadeId: string | null
    // 公共隧道 URL
    publicUrl: string | null
}

export const state: State = {
    antigravityToken: null,
    accessToken: null,
    refreshToken: null,
    tokenExpiresAt: null,
    userEmail: null,
    userName: null,
    port: 44444,  // 🆕 修正为 anti-api 实际端口
    verbose: false,
    cloudaicompanionProject: null,
    cascadeId: null,
    publicUrl: null,
}
