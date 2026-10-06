import json, time, urllib.request, os

BASE = 'http://127.0.0.1:17841'

# 本机服务必须直连：环境里若配了 HTTP 代理，urllib 会把 127.0.0.1 也走代理，直接吃 502
os.environ['no_proxy'] = '127.0.0.1,localhost'
os.environ['NO_PROXY'] = '127.0.0.1,localhost'
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))


def get(url, timeout=20):
    return json.loads(urllib.request.urlopen(url, timeout=timeout).read().decode())


def post(path, payload, timeout=15):
    """返回 (状态码, 响应片段)。状态码 0 = 请求超时（服务端在跑，属于正常）。"""
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                headers={'Content-Type': 'application/json'})
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return (r.status, r.read().decode()[:200])
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode()[:200]
        except Exception:
            body = ''
        return (e.code, body)
    except Exception as e:
        return (0, type(e).__name__)


def hits():
    return get(BASE + '/api/uploads')['hits']


def needs(h):
    # 静音/无语音素材（skipped）本来就不适用文本分析，别白跑
    if h.get('status') == 'skipped':
        return False
    # 新维度缺失（要点为空且没有全文案）→ 视为旧拆解，需要重跑
    return not (h.get('viralPoints') and len(h.get('viralPoints')) > 0) and not h.get('hasFullTranscript')


todo = [h for h in hits() if needs(h)]
print('待重分析：%d 条' % len(todo), flush=True)

for i, h in enumerate(todo, 1):
    print('[%d/%d] %s' % (i, len(todo), h['name']), flush=True)
    # 总是触发一次：服务端有去重锁（同一条并发会返回 409），所以触发是安全的；
    # 反过来只信库里的 analyzing 状态会被上次中断的残留状态骗到，白等一场。
    code, body = post('/pipeline/analyze-hit', {'videoPath': h['path']})
    if code == 409:
        print('   服务端正在分析这条（去重锁拦截），耐心等待…', flush=True)
    elif code == 0:
        print('   已触发（服务端在处理，请求超时属正常）', flush=True)
    else:
        print('   已触发 -> HTTP %s %s' % (code, body[:80]), flush=True)

    ok = False
    # 最多等 45 分钟/条：GPU 被别的任务占满时 Hermes 会主动让路，
    # 只要服务端还显示 analyzing 就一直等，不再触发下一条（避免堆积）
    for _ in range(270):
        time.sleep(10)
        cur = next((x for x in hits() if x['path'] == h['path']), None)
        if not cur:
            break
        st = cur.get('status')
        if st == 'completed' and cur.get('hasFullTranscript'):
            print('   OK 完成：标题=%s 要点%d 画面字%d 情绪%d 封面=%s' % (
                cur.get('title'), len(cur.get('viralPoints') or []),
                len(cur.get('onScreenTexts') or []), len(cur.get('emotionCurve') or []),
                '有' if cur.get('coverFrame') else '无'), flush=True)
            ok = True
            break
        if st == 'failed':
            print('   FAIL 分析失败', flush=True)
            break
    if not ok:
        print('   SKIP 超时/跳过，继续下一条', flush=True)

print('全部处理完毕', flush=True)
