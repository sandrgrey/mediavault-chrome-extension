// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReelSaveControl } from '../../src/content/ReelSaveControl';
it('explains reload, disables Save while busy, and rejects synthetic page clicks', () => {
  const save = vi.fn(), cancel = vi.fn();
  const { rerender } = render(<ReelSaveControl message="Готово" busy={false} canCancel={false} redownload={false} save={save} cancel={cancel} />);
  expect(screen.getByText('Для сохранения страница будет перезагружена')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Save Reel' }));
  expect(save).not.toHaveBeenCalled();
  rerender(<ReelSaveControl message="Сбор" busy={true} canCancel={true} redownload={false} save={save} cancel={cancel} />);
  expect((screen.getByRole('button', { name: 'Save Reel' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Отмена' })).toBeDefined();
});

