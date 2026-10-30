import os
import sys
import json
import numpy as np
import open3d as o3d

BASE_DIR = r"C:\Users\Atharv\Desktop\3d mapping\monomap"
OUT_DIR = os.path.join(BASE_DIR, "output", "scan_posecam_1")
MODELS_DIR = os.path.join(OUT_DIR, "models")

print("Generating Model 9 & 10...")
# Model 9: Boxes
m9_path = os.path.join(MODELS_DIR, "model_09_digital_twin_boxes.ply")
boxes_path = os.path.join(OUT_DIR, "boxes.json")
m9_mesh = o3d.geometry.TriangleMesh()
if os.path.exists(boxes_path):
    with open(boxes_path) as f:
        box_data = json.load(f)
    boxes_list = box_data if isinstance(box_data, list) else box_data.get("boxes", [])
    for b in boxes_list:
        ext = b.get("extent", [0.5, 0.5, 0.5])
        ctr = b.get("center", [0, 0, 0])
        box_mesh = o3d.geometry.TriangleMesh.create_box(width=ext[0], height=ext[1], depth=ext[2])
        box_mesh.translate(np.array(ctr) - np.array(ext)/2.0)
        box_mesh.paint_uniform_color(np.random.uniform(0.4, 0.9, 3))
        m9_mesh += box_mesh
if len(m9_mesh.triangles) == 0:
    m6_path = os.path.join(MODELS_DIR, "model_06_planar_cad_bim.ply")
    if os.path.exists(m6_path):
        m9_mesh = o3d.io.read_triangle_mesh(m6_path)
    else:
        m9_mesh = o3d.geometry.TriangleMesh.create_box(1, 1, 1)

o3d.io.write_triangle_mesh(m9_path, m9_mesh)
print(f"Model 9: {len(m9_mesh.triangles)} tris -> {m9_path}")

# Model 10: Oriented Surface Normal Field
m10_path = os.path.join(MODELS_DIR, "model_10_oriented_surfels.ply")
clean_path = os.path.join(OUT_DIR, "map_metric_clean.ply")
pcd = o3d.io.read_point_cloud(clean_path).voxel_down_sample(0.035)
if not pcd.has_normals() or len(pcd.normals) == 0:
    pcd.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=0.10, max_nn=25))
normals = np.asarray(pcd.normals)
normal_colors = np.clip(0.5 * (normals + 1.0), 0.0, 1.0)
pcd.colors = o3d.utility.Vector3dVector(normal_colors)
o3d.io.write_point_cloud(m10_path, pcd)
o3d.io.write_point_cloud(os.path.join(MODELS_DIR, "model_10_normal_field.ply"), pcd)
print(f"Model 10: {len(pcd.points)} points -> {m10_path}")

print("DONE!")
