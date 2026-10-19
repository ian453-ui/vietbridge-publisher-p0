# 云端管理端部署

当前版本支持独立 Linux 容器启动、客户管理、主题规则和额度管理。
这是单运营团队管理端，管理员可访问所有客户；尚不是支持客户自行登录的 SaaS。
本地 V1 内容库、文件读取、浏览器和发布执行接口在云模式中禁用。
本地执行器配对、云端媒体上传和平台 OAuth 是后续迁移内容。

## 启动

配置 PUBLIC_ORIGIN=https://social.vietbridge.one、ADMIN_USER 和至少24字符的随机 ADMIN_PASSWORD。
通过服务器环境提供密码，不提交到仓库。
运行 docker compose -f compose.cloud.yaml up -d --build。

使用 HTTPS 反向代理转发至 127.0.0.1:18082，并保留 Host 头。
在代理上设置登录速率限制。容器端口只绑定服务器回环地址。
DNS 未绑定前可用临时 HTTPS 域名，但 PUBLIC_ORIGIN 必须与访问域名一致。

浏览器通过 HTTP Basic 登录；密码只应通过 HTTPS 传输。
所有页面、API 和健康检查均要求登录。
首次启动仍包含演示客户，请勿把演示记录当作真实发布证据。

## 数据

SQLite 位于 publisher-data 持久卷。首版运行一个实例，不支持多副本写入。
备份需使用 SQLite backup API 或停止容器后复制整个卷，不能仅复制活动数据库主文件。
不要把 Mac 上的凭据、浏览器 Cookie 或历史数据库直接打包进镜像。

## 验收边界

测试覆盖未登录拒绝、错误 Host 拒绝和云端禁止调用本地执行接口。
上线前还需在目标服务器构建镜像、配置 TLS、验证数据卷重启恢复。
