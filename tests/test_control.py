"""Live steering and graceful stop of the agentic loop (evolve/control.py)."""

from __future__ import annotations

import io
import json
import os
import time
from pathlib import Path
from typing import Any

from typer.testing import CliRunner

from autotinker.agent.router import ScriptedChat
from autotinker.cli import app
from autotinker.evolve.agentic import AgenticConfig, run_agentic
from autotinker.evolve.control import ControlChannel, ControlCommand, parse_command
from autotinker.obs.events import parse_event
from tests.agentic_helpers import PROFILER, code_reply, critic, fake_code, judge, plan, reporter
from tests.conftest import FakeHarness

STARTER = fake_code(0.5, tag="starter")


def _chat(n: int = 6) -> ScriptedChat:
    return ScriptedChat(
        {
            "profiler": [PROFILER],
            "planner": [plan(f"idea {i}", "linear", radical=True) for i in range(n)],
            "coder": [code_reply(fake_code(0.6 + i / 100, tag=f"c{i}")) for i in range(n)],
            "critic": [critic()] * n,
            "judge": [judge()] * n,
            "reporter": [reporter()],
        }
    )


def _cfg(**kw: Any) -> AgenticConfig:
    base: dict[str, Any] = dict(max_experiments=4, n_drafts=2, ablation_every=0, stall_for_tune=99)
    base.update(kw)
    return AgenticConfig(**base)


def _events(tmp_path: Path) -> list[Any]:
    return [parse_event(ln) for ln in (tmp_path / "events.jsonl").read_text().splitlines()]


def test_parse_command() -> None:
    assert parse_command('{"type":"stop"}') == ControlCommand("stop")
    steer = parse_command('{"type":"steer","text":"  prefer   linear  "}')
    assert steer == ControlCommand("steer", "prefer linear")
    long = parse_command('{"type":"steer","text":"' + "x" * 900 + '"}')
    assert long is not None and long.text == "x" * 300
    for bad in ("", "nope", "[1]", '{"type":"steer"}', '{"type":"steer","text":"  "}', '{"type":"reboot"}'):
        assert parse_command(bad) is None


def test_channel_reads_a_stream_and_skips_bad_lines() -> None:
    stream = io.StringIO('{"type":"steer","text":"no deep models"}\nnot json\n\n{"type":"stop"}\n')
    ch = ControlChannel.from_stream(stream)
    assert ch._thread is not None
    ch._thread.join(timeout=2)
    assert ch.drain() == [ControlCommand("steer", "no deep models"), ControlCommand("stop")]
    assert ch.stop_requested
    assert ch.drain() == []


def test_channel_reads_a_pipe_without_blocking() -> None:
    r, w = os.pipe()
    ch = ControlChannel.from_stream(os.fdopen(r, encoding="utf-8"))
    assert ch.drain() == []  # nothing written yet; drain never blocks
    with os.fdopen(w, "w", encoding="utf-8") as f:
        f.write('{"type":"steer","text":"focus on recall"}\n')
        f.flush()
        deadline = time.time() + 2
        got: list[ControlCommand] = []
        while not got and time.time() < deadline:
            got = ch.drain()
            time.sleep(0.01)
    assert got == [ControlCommand("steer", "focus on recall")]
    assert not ch.stop_requested


def test_steer_reaches_planner_prompt_and_is_acknowledged(tmp_path: Path) -> None:
    chat = _chat()
    ch = ControlChannel()
    ch.push(ControlCommand("steer", "prefer simple linear models"))
    run_agentic(
        FakeHarness(),
        chat,
        cfg=_cfg(),
        goal="predict y",
        run_dir=tmp_path,
        starter_code=STARTER,
        contract_doc="CONTRACT",
        control=ch,
    )
    planner_prompts = [json.dumps(r.messages) for r in chat.requests if r.role == "planner"]
    assert planner_prompts and all("prefer simple linear models" in p for p in planner_prompts)
    assert "User constraints" in planner_prompts[0]
    acks = [e for e in _events(tmp_path) if e.type == "steer_applied"]
    assert len(acks) == 1 and acks[0].text == "prefer simple linear models"
    assert acks[0].at_exp == "e000"  # consumed during profiling, before any experiment was planned
    started = [e for e in _events(tmp_path) if e.type == "experiment_started"]
    assert [e.phase for e in started][:3] == ["baseline", "draft", "draft"]


def test_steer_mid_run_applies_to_the_next_planner_only(tmp_path: Path) -> None:
    chat = _chat()
    ch = ControlChannel()

    def on_event(ev: Any) -> None:
        if ev.type == "decision" and ev.exp_id == "e001":
            ch.push(ControlCommand("steer", "no deep models"))

    run_agentic(
        FakeHarness(),
        chat,
        cfg=_cfg(),
        run_dir=tmp_path,
        starter_code=STARTER,
        contract_doc="CONTRACT",
        control=ch,
        on_event=on_event,
    )
    prompts = [json.dumps(r.messages) for r in chat.requests if r.role == "planner"]
    assert "no deep models" not in prompts[0]  # e001's planner ran before the steer
    assert all("no deep models" in p for p in prompts[1:])
    ack = next(e for e in _events(tmp_path) if e.type == "steer_applied")
    assert ack.at_exp == "e002"


def test_stop_is_graceful_locked_test_and_report_still_run(tmp_path: Path) -> None:
    chat = _chat()
    ch = ControlChannel()
    h = FakeHarness()

    def on_event(ev: Any) -> None:
        if ev.type == "experiment_started" and ev.exp_id == "e001":
            ch.push(ControlCommand("stop"))  # arrives mid-experiment

    rec = run_agentic(
        h,
        chat,
        cfg=_cfg(max_experiments=8),
        run_dir=tmp_path,
        starter_code=STARTER,
        contract_doc="CONTRACT",
        control=ch,
        on_event=on_event,
    )
    assert rec.stop and rec.stop["reason"] == "user"
    assert "after e001" in rec.stop["summary"]
    assert [e.id for e in rec.experiments] == ["e000", "e001"]  # the in-flight experiment finished
    assert rec.final is not None and h.test_calls == 1
    assert rec.report is not None
    types = [e.type for e in _events(tmp_path)]
    assert types.index("stopped") < types.index("run_finished") < types.index("report_ready")


def test_cli_control_flags_are_listed() -> None:
    res = CliRunner().invoke(app, ["run", "--help"], env={"COLUMNS": "200"})
    assert res.exit_code == 0
    assert "--control-stdin" in res.output and "--control-fifo" in res.output
