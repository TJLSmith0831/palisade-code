import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useMessageQueue } from '../hooks/useMessageQueue';

it('holds messages while a thread works, sends FIFO, and allows removal', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(({ busy }) => useMessageQueue(busy, send), { initialProps: { busy: new Set(['t1']) } });
  act(() => { result.current.enqueue('p1', 't1', 'First'); result.current.enqueue('p1', 't1', 'Remove'); });
  expect(send).not.toHaveBeenCalled();
  act(() => result.current.remove(result.current.items[1].id));
  rerender({ busy: new Set() });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0][0]).toMatchObject({ projectHash: 'p1', threadId: 't1', text: 'First' });
  await waitFor(() => expect(result.current.items).toHaveLength(0));
});

it('retains failed messages for explicit retry instead of looping or losing them', async () => {
  const send = vi.fn().mockRejectedValue(new Error('Offline'));
  const { result } = renderHook(() => useMessageQueue(new Set(), send));
  act(() => result.current.enqueue('p1', 't1', 'Keep this'));
  await waitFor(() => expect(result.current.items[0].error).toBe('Offline'));
  expect(send).toHaveBeenCalledTimes(1);
  send.mockResolvedValue(undefined);
  act(() => result.current.retry(result.current.items[0].id));
  await waitFor(() => expect(result.current.items).toHaveLength(0));
  expect(send).toHaveBeenCalledTimes(2);
});
