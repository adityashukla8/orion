# ADK requires the exported name to be exactly `root_agent`.
# main.py imports it as: from orion_orchestrator import root_agent
from .agent import root_agent

__all__ = ['root_agent']
