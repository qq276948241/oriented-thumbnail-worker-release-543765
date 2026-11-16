# JPEG 缩略图服务

基于本仓库自带的纯 JavaScript JPEG 编解码库（jpeg-js）的缩略图 HTTP 服务。**零第三方运行时依赖**（仅 Node.js 标准库：http / worker_threads / crypto / fs），Node.js ≥ 18 即可运行。

## 启动

```bash
node service/main.js          # 或 npm run start
```

所有配置均来自环境变量，启动时会把生效配置完整打印到日志（可复现部署）：

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | 监听地址 |
| `DATA_DIR` | `./data` | 任务记录、已发布输出、临时文件的根目录 |
| `MAX_UPLOAD_BYTES` | `10485760` | 单次上传请求体上限（字节） |
| `MAX_INPUT_PIXELS` | `40000000` | 输入图片像素上限（宽×高，不解码即可判定） |
| `MAX_TARGET_TOTAL_PIXELS` | `4000000` | 单任务所有目标尺寸像素之和上限 |
| `MAX_TARGETS_PER_TASK` | `16` | 单任务目标数量上限 |
| `MAX_CONCURRENT_TASKS` | `2` | 同时处理的任务数 |
| `MAX_QUEUE_LENGTH` | `8` | 排队任务数上限 |
| `WORKER_COUNT` | `2` | 编解码工作线程数 |
| `TASK_TIMEOUT_MS` | `30000` | 任务从接受到完成的最长时限 |
| `SHUTDOWN_GRACE_MS` | `10000` | 退出前等待已接任务完成的期限 |
| `DECODE_MAX_RESOLUTION_MP` / `DECODE_MAX_MEMORY_MB` | `100` / `512` | 透传给 jpeg-js 的解码兜底限制 |

## 接口

### `POST /tasks` — 提交任务

```json
{
  "idempotencyKey": "order-123",        // 可选，1-200 字符
  "image": "<base64 编码的 JPEG>",
  "orientation": 6,                      // 可选，1-8；缺省读 EXIF，无 EXIF 视为 1
  "targets": [
    { "width": 100, "height": 100, "quality": 85 },
    { "width": 30, "height": 20, "crop": { "x": 10, "y": 0, "width": 200, "height": 100 } }
  ]
}
```

- `202` 新任务已受理，返回 `{ "taskId", "status", ... }`；幂等重放返回 `200` 与原任务。
- `400` 参数非法 / 不是可解析的 JPEG；`413` 超字节、输入像素或目标像素上限；`429` 并行+排队已满；`409` 幂等键冲突（同键不同内容）；`503` 正在退出。
- 所有拒绝都发生在占名额之前，被拒绝的请求不消耗并行或排队名额。

### `GET /tasks/:id` — 查询任务

`status` ∈ `queued | processing | succeeded | failed | cancelled`。成功后 `outputs` 给出每张缩略图的实际尺寸与下载地址；失败时 `error` 给出原因（如 `crop_out_of_bounds`、`task_timeout`、`worker_crash`、`interrupted_by_shutdown`）。

### `GET /tasks/:id/outputs/:index` — 下载缩略图

仅当整组目标全部成功（`succeeded`）后才可下载；其余状态返回 `409`。任何一张失败都会整组回滚，不留部分结果和临时文件。

### `POST /tasks/:id/cancel` — 取消

排队或处理中的任务都可取消（处理中的任务通过终止工作线程中断）。终态任务返回 `409`。已取消任务不会被迟到的结果改回成功。

### `GET /health` / `GET /ready`

健康检查永远立即响应：所有同步编解码都在工作线程中执行，HTTP 线程不做重活。`/ready` 在退出流程中返回 `503`。

## 图像处理规则

1. **方向校正**：先按请求给定的方向（1-8，EXIF 语义；缺省自动读 EXIF）把存储像素变换到显示坐标系，支持全部八种（含镜像），5-8 会交换宽高。
2. **裁切**：在校正后的坐标系中进行，`{x, y, width, height}` 必须满足 `x≥0, y≥0, x+width≤W, y+height≤H`，越界直接失败（整组回滚）。贴边裁切（`x+width==W`）合法。
3. **等比缩放**：`scale = min(targetW/cropW, targetH/cropH, 1)` —— 不放大小图。
4. **取整规则**：`输出边长 = max(1, round(输入边长 × scale))`，四舍五入（0.5 进位）。
5. 重采样为双线性插值；每张缩略图按各自 `quality`（1-100，默认 80）重新编码为 JPEG。
6. 解码后的原始像素被所有目标共享但永不被修改：每个像素操作都分配新缓冲，某一目标的裁切/缩放不会影响其他目标。

## 幂等

同一 `idempotencyKey` + 相同图片字节与参数（图片 SHA-256 + 参数规范化串的联合哈希，与文件名无关）重复提交 → 返回原任务（`200`）；同键不同内容 → `409 idempotency_conflict`。幂等记录随任务记录持久化，重启后仍然有效。

## 退出与重启

- `SIGTERM`/`SIGINT`：立即停止接受新任务与新的连接，已接受的任务等待至 `SHUTDOWN_GRACE_MS` 期限，到期后终止剩余处理并清理临时资源，然后退出（退出码 0）。
- 所有状态迁移都同步落盘（`DATA_DIR/jobs/<id>.json`）。重启时：仍处于 `queued`/`processing` 的记录一律标记为 `failed(interrupted_by_restart)`，**未完成的任务永远不会被报成成功**；`tmp/` 中的孤儿暂存目录全部清除；没有对应成功记录的输出目录也会被清除，旧文件不会被新任务误认领。
- 输出以任务级原子方式发布：先写入 `tmp/<id>/`，整组成功后 `rename` 到 `tasks/<id>/`，再落盘任务记录。

## 数据目录

```
DATA_DIR/
  jobs/<taskId>.json    # 任务记录（每次状态迁移原子重写）
  tmp/<taskId>/         # 暂存：input.jpg 与未发布的 out-N.jpg
  tasks/<taskId>/       # 已发布输出 out-N.jpg
```

任务记录会长期保留以支撑幂等重放；如需清理，可定时删除过老的 `jobs/*.json` 与对应 `tasks/` 目录（服务只在启动时读取记录，运行中删除记录仅影响幂等重放与历史查询）。

## 验收

```bash
npm run acceptance        # node test-acceptance/run.js
```

无需公网：全部流量在 127.0.0.1。套件会真实启动多个服务实例（不同配置），覆盖：八种方向校正、横竖图、非整倍缩放与取整、贴边/越界裁切、整组回滚、幂等重放与冲突、队列满 429、处理中取消、任务超时、工作线程崩溃恢复、坏图、负载下健康检查、优雅退出与重启恢复。每个用例会打印关键请求/响应与解码后的图像断言（尺寸、色块位置）。
