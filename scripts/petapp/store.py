"""桌宠的本地文件：配置、运行状态、单实例锁。

★ 与主应用的分工（沿用现有边界，没有改动）：
  · `pet-config.json` 由设置页写、桌宠只读；桌宠自己改模型/置顶时也写它，
    但走的是同一个 `PUT /api/pet/config`，不另造一份真相源；
  · `pet-state.json` 只有桌宠写（位置、会话 id），主应用不碰；
  · `pet.pid` / `pet.lock` 分两个文件：锁负责互斥，PID 必须可读
    （Windows 文件锁会挡住别的进程读，那条坑已经在旧版踩过）。
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[2]
ASSET_DIR = ROOT_DIR / 'public' / 'pet'

DEFAULT_CONFIG: dict[str, Any] = {
    'version': 1,
    'enabled': True,
    'displayMode': 'desktop',
    'autoStart': False,
    'size': 220,
    'sprite': 'butler',
    'alwaysOnTop': True,
    'model': None,
    'thinkingLevel': 'default',
    'persona': '',
    'proactiveEnabled': False,
    'proactiveFrequency': 'normal',
    'quietStart': '22:30',
    'quietEnd': '08:00',
    'proactiveScenarios': {
        'lateNight': True,
        'longSession': True,
        'return': True,
    },
}

THINKING_LEVELS = ('default', 'low', 'medium', 'high')

# 桌宠旧档位 → 会话级统一四档。
# `default` / `medium` 都映射到 high：旧实现里它们与 high 无实际区别。
THINKING_TO_REASONING = {
    'default': 'high',
    'low': 'low',
    'medium': 'high',
    'high': 'high',
}


def reasoning_for_thinking_level(level: str) -> str | None:
    """旧桌宠档位 → 统一四档；非法值返回 None（不发送）。"""
    return THINKING_TO_REASONING.get(level)


def session_settings_patch(config: dict[str, Any]) -> dict[str, Any]:
    """从桌宠配置生成会话 PATCH 字段。

    ★ 只包含桌宠真正拥有的两项：模型与思考强度。
      人格不在这里 PATCH —— 会话人格是 Web 设置，桌宠旧配置只做请求级回退。
    """
    patch: dict[str, Any] = {}
    model = config.get('model')
    if isinstance(model, dict):
        profile_id = model.get('profileId')
        model_id = model.get('modelId')
        if (
            isinstance(profile_id, str)
            and profile_id.strip()
            and isinstance(model_id, str)
            and model_id.strip()
        ):
            patch['modelProfileId'] = profile_id.strip()
            patch['modelId'] = model_id.strip()
    level = config.get('thinkingLevel')
    if isinstance(level, str):
        reasoning = reasoning_for_thinking_level(level)
        if reasoning is not None:
            patch['reasoning'] = reasoning
    return patch


class Paths:
    def __init__(self, data_dir: Path | str | None = None) -> None:
        raw = data_dir if data_dir is not None else os.environ.get('BUTLER_DATA_DIR')
        self.data_dir = Path(raw).expanduser() if raw else ROOT_DIR / '.butler-data'
        self.config = self.data_dir / 'pet-config.json'
        self.state = self.data_dir / 'pet-state.json'
        self.pid = self.data_dir / 'pet.pid'
        self.lock = self.data_dir / 'pet.lock'
        self.error_log = self.data_dir / 'pet-error.log'


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return fallback


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'{path.name}.{os.getpid()}.{int(time.time() * 1000)}.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(tmp, path)


# ═══════════════════════════════════════════════════════════
# 配置
# ═══════════════════════════════════════════════════════════


def normalize_config(raw: Any) -> dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    if isinstance(raw, dict):
        for key in cfg:
            if key in raw:
                cfg[key] = raw[key]
    try:
        cfg['size'] = max(120, min(480, int(cfg.get('size', 220))))
    except Exception:
        cfg['size'] = 220
    if not isinstance(cfg.get('persona'), str):
        cfg['persona'] = ''
    cfg['persona'] = cfg['persona'][:4000]
    if not isinstance(cfg.get('sprite'), str) or not cfg['sprite'].strip():
        cfg['sprite'] = 'butler'
    if cfg.get('thinkingLevel') not in THINKING_LEVELS:
        cfg['thinkingLevel'] = 'default'
    if cfg.get('displayMode') not in ('desktop', 'web'):
        cfg['displayMode'] = 'desktop'
    if cfg.get('proactiveFrequency') not in ('rare', 'normal', 'often'):
        cfg['proactiveFrequency'] = 'normal'
    for key in ('quietStart', 'quietEnd'):
        value = cfg.get(key)
        if not isinstance(value, str) or len(value) != 5 or value[2] != ':':
            cfg[key] = DEFAULT_CONFIG[key]
    scenarios = cfg.get('proactiveScenarios')
    if not isinstance(scenarios, dict):
        scenarios = {}
    cfg['proactiveScenarios'] = {
        'lateNight': scenarios.get('lateNight') is not False,
        'longSession': scenarios.get('longSession') is not False,
        'return': scenarios.get('return') is not False,
    }
    cfg['proactiveEnabled'] = cfg.get('proactiveEnabled') is True
    if cfg.get('model') is not None and not (
        isinstance(cfg['model'], dict)
        and isinstance(cfg['model'].get('profileId'), str)
        and isinstance(cfg['model'].get('modelId'), str)
    ):
        cfg['model'] = None
    return cfg


def load_config(paths: Paths) -> dict[str, Any]:
    return normalize_config(read_json(paths.config, DEFAULT_CONFIG))


def save_config(paths: Paths, cfg: dict[str, Any]) -> None:
    write_json_atomic(paths.config, cfg)


# ═══════════════════════════════════════════════════════════
# 运行状态（位置 / 会话）
# ═══════════════════════════════════════════════════════════


def load_state(paths: Paths) -> dict[str, Any]:
    raw = read_json(paths.state, {})
    return raw if isinstance(raw, dict) else {}


def save_state(paths: Paths, state: dict[str, Any]) -> None:
    write_json_atomic(paths.state, state)


# ═══════════════════════════════════════════════════════════
# 单实例
# ═══════════════════════════════════════════════════════════


def acquire_instance_lock(paths: Paths) -> Any | None:
    """拿不到锁说明已经有一只桌宠在跑。

    ⚠️ 这里必须用**文件锁**而不是「看看 PID 在不在」：
       设置页点两次「启动」、或双击 .bat 与托盘同时拉起时，
       两个进程会同时通过 PID 检查，然后叠出两只桌宠。
    """
    paths.data_dir.mkdir(parents=True, exist_ok=True)
    handle = None
    try:
        handle = open(paths.lock, 'a+', encoding='utf-8')
        if os.name == 'nt':
            import msvcrt

            handle.seek(0)
            if handle.read(1) == '':
                handle.write('0')
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        paths.pid.write_text(str(os.getpid()), encoding='utf-8')
        return handle
    except Exception:
        try:
            if handle is not None:
                handle.close()
        except Exception:
            pass
        return None


def release_instance_lock(paths: Paths, handle: Any | None) -> None:
    if handle is not None:
        try:
            if os.name == 'nt':
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except Exception:
            pass
        try:
            handle.close()
        except Exception:
            pass
    try:
        if paths.pid.exists() and paths.pid.read_text(encoding='utf-8').strip() == str(os.getpid()):
            paths.pid.unlink()
    except Exception:
        pass
