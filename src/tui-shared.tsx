import { Box, Text } from "ink";
import React from "react";
import { sanitizeTerminal } from "./sanitize.js";

export function PageFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} minHeight={22} width="100%"><Text bold color="cyan">{title}</Text>{children}</Box>;
}

export function ChoiceList({ title, values, selected }: { title: string; values: readonly string[]; selected: number }) {
  return <><Text bold>{title}</Text>{values.map((value, index) => <Text key={value} inverse={index === selected}>{index === selected ? "›" : " "} {value}</Text>)}<Text dimColor>↑↓ select · Enter continue · Esc back</Text></>;
}

export function errorMessage(reason: unknown): string { return sanitizeTerminal(reason instanceof Error ? reason.message : String(reason)).slice(-240); }
