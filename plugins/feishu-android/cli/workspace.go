package main

import (
	"context"
	"errors"
	"github.com/larksuite/cli/extension/fileio"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const fileLimit = int64(32 << 20)

type workspace struct {
	root *os.Root
	path string
}
type savedFile int64

func (size savedFile) Size() int64 { return int64(size) }
func newWorkspace(path string) (*workspace, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("INVALID_WORKSPACE")
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	return &workspace{root, filepath.Clean(path)}, nil
}
func (w *workspace) Name() string                                { return "familiar-workspace" }
func (w *workspace) Close()                                      { _ = w.root.Close() }
func (w *workspace) ResolveFileIO(context.Context) fileio.FileIO { return w }
func (w *workspace) relative(name string) (string, error) {
	if filepath.IsAbs(name) {
		relative, err := filepath.Rel(w.path, name)
		if err != nil {
			return "", err
		}
		name = relative
	}
	if !filepath.IsLocal(name) || strings.ContainsRune(name, 0) {
		return "", errors.New("OUTSIDE_WORKSPACE")
	}
	return filepath.Clean(name), nil
}
func (w *workspace) Open(name string) (fileio.File, error) {
	name, err := w.relative(name)
	if err != nil {
		return nil, err
	}
	file, err := w.root.Open(name)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > fileLimit {
		file.Close()
		return nil, errors.New("INVALID_FILE")
	}
	return file, nil
}
func (w *workspace) Stat(name string) (fileio.FileInfo, error) {
	name, err := w.relative(name)
	if err != nil {
		return nil, err
	}
	return w.root.Stat(name)
}
func (w *workspace) ResolvePath(name string) (string, error) {
	name, err := w.relative(name)
	if err != nil {
		return "", err
	}
	// 上游也用此接口做目录预检；检查最近的现存父级，拒绝静态软链接越界。
	// 真正读写仍使用根句柄，不能只依赖这次可能过期的路径检查。
	for current := name; ; current = filepath.Dir(current) {
		_, err = w.root.Stat(current)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) || current == "." {
			return "", err
		}
	}
	return filepath.Join(w.path, name), nil
}
func (w *workspace) Save(name string, opts fileio.SaveOptions, body io.Reader) (fileio.SaveResult, error) {
	return w.save(name, opts, body, false)
}
func (w *workspace) SaveExclusive(name string, opts fileio.SaveOptions, body io.Reader) (fileio.SaveResult, error) {
	return w.save(name, opts, body, true)
}
func (w *workspace) save(name string, opts fileio.SaveOptions, body io.Reader, exclusive bool) (fileio.SaveResult, error) {
	name, err := w.relative(name)
	if err != nil {
		return nil, err
	}
	if opts.ContentLength > fileLimit {
		return nil, errors.New("FILE_TOO_LARGE")
	}
	if err = w.root.MkdirAll(filepath.Dir(name), 0700); err != nil {
		return nil, err
	}
	// 临时文件也从根句柄创建；目录或软链接被替换时，不能逃出授权工作区。
	temp := filepath.Join(filepath.Dir(name), ".familiar-"+randomFileID())
	file, err := w.root.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	defer w.root.Remove(temp)
	written, copyErr := io.Copy(file, io.LimitReader(body, fileLimit+1))
	closeErr := file.Close()
	if copyErr != nil {
		return nil, copyErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if written > fileLimit {
		return nil, errors.New("FILE_TOO_LARGE")
	}
	if exclusive {
		if err = w.root.Link(temp, name); err != nil {
			return nil, err
		}
	} else if err = w.root.Rename(temp, name); err != nil {
		return nil, err
	}
	return savedFile(written), nil
}
func (w *workspace) RemoveWorkspaceEntry(name string) error {
	name, err := w.relative(name)
	if err != nil {
		return err
	}
	if name == "." {
		return errors.New("INVALID_PATH")
	}
	return w.root.Remove(name)
}
