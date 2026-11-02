import os
import time
import torch
import numpy as np
from PIL import Image, ImageOps
import folder_paths
from server import PromptServer
from aiohttp import web

# 注册独立清理临时目录的后端接口
@PromptServer.instance.routes.post("/crazy3ds/clear_temp")
async def clear_crazy3ds_temp(request):
    temp_dir = os.path.join(folder_paths.get_input_directory(), "crazy3ds_temp")
    if os.path.exists(temp_dir):
        for f in os.listdir(temp_dir):
            fp = os.path.join(temp_dir, f)
            try:
                if os.path.isfile(fp):
                    os.remove(fp)
            except Exception:
                pass
    return web.json_response({"status": "success"})


class Crazy3DS_LayoutCompositor:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_name": ("STRING", {"default": ""}),
            },
            "optional": {
                "images": ("IMAGE",),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "execute"
    CATEGORY = "Crazy3DS"

    # 基于文件的物理修改时间与文件大小，彻底击碎缓存
    @classmethod
    def IS_CHANGED(cls, image_name="", **kwargs):
        if image_name:
            input_dir = folder_paths.get_input_directory()
            image_path = os.path.join(input_dir, image_name)
            if os.path.exists(image_path):
                return f"{os.path.getmtime(image_path)}_{os.path.getsize(image_path)}"
        return str(time.time())

    def execute(self, image_name="", images=None):
        if image_name:
            input_dir = folder_paths.get_input_directory()
            image_path = os.path.join(input_dir, image_name)
            if not os.path.exists(image_path):
                image_path = folder_paths.get_annotated_filepath(image_name)

            if os.path.exists(image_path):
                i = Image.open(image_path)
                i = ImageOps.exif_transpose(i)
                if i.mode == 'RGBA':
                    bg = Image.new('RGB', i.size, (255, 255, 255))
                    bg.paste(i, mask=i.split()[3])
                    i = bg
                else:
                    i = i.convert("RGB")

                img_np = np.array(i).astype(np.float32) / 255.0
                out_tensor = torch.from_numpy(img_np)[None, ...]
                return (out_tensor,)

        if images is not None:
            return (images,)

        fallback = torch.ones((1, 1024, 1024, 3), dtype=torch.float32)
        return (fallback,)


NODE_CLASS_MAPPINGS = {
    "Crazy3DS_LayoutCompositor": Crazy3DS_LayoutCompositor
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Crazy3DS_LayoutCompositor": "Crazy3DS - 视觉拼贴与手绘画板"
}

WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]