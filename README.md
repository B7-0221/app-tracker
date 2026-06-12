# App Tracker - 部署和使用说明

## 第一步：部署到Railway

1. 打开 https://railway.app，用GitHub账号登录
2. 把这个 `app-tracker` 文件夹上传到一个新的GitHub仓库（可以用GitHub网页直接拖文件上传，也可以用git命令）
3. 在Railway点击 "New Project" -> "Deploy from GitHub repo"，选择你刚创建的仓库
4. Railway会自动识别是Node.js项目并部署
5. 部署完成后，在Settings里点击 "Generate Domain"，会得到一个类似 `https://xxx.up.railway.app` 的地址
6. 记住这个地址，下面会用到

## 第二步：设置iPhone快捷指令

1. 打开"快捷指令"App
2. 点击右上角 "+" 创建新的自动化
3. 选择"App" -> 选择你想追踪的App（比如抖音、小红书）
4. 触发条件选择"打开时"
5. 添加动作：搜索"获取App Store App的详细信息"，选择刚才那个App
6. 再添加动作：搜索"获取URL内容"
   - URL填: `https://你的railway地址/report`
   - 方法选择 POST
   - 请求体选择"表单"，添加一个字段，键填 `app`，值选择上一步获取到的"名称"
7. 关闭"运行前询问"，保存

对每个想追踪的App重复上面步骤。

## 第三步：测试

打开你设置的App，然后在浏览器访问：
`https://你的railway地址/recent`

应该能看到刚才打开App的记录。

## 第四步：连接给Claude

这部分需要把 `/current` 接口包装成MCP工具。这一步比较技术性，
如果前面两步搭建成功，把Railway地址发给我，我可以帮你想下一步怎么接入。

## 注意

这个服务器存储的是公开的、任何知道地址的人都能访问的数据（没有做权限验证）。
不要在 `report` 里包含任何敏感信息（密码、聊天内容等），只放App名字。
