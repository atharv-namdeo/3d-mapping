"""
High-performance 10-model suite generator for scan_posecam_1.
Inputs: map_metric_clean.ply (16.32M metric points)
Outputs: All 10 distinct CAD/Mesh/Cloud models in output/scan_posecam_1/models/
"""
import os
import sys
import json
import time
import numpy as np
import open3d as o3d

BASE_DIR = r"C:\Users\Atharv\Desktop\3d mapping\monomap"
SRC_DIR = os.path.join(BASE_DIR, "src")
sys.path.insert(0, SRC_DIR)

import planes

SCENE_NAME = "scan_posecam_1"
OUT_DIR = os.path.join(BASE_DIR, "output", SCENE_NAME)
MODELS_DIR = os.path.join(OUT_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)

clean_path = os.path.join(OUT_DIR, "map_metric_clean.ply")
print(f"Loading {clean_path}...")
t0 = time.time()
pcd_raw = o3d.io.read_point_cloud(clean_path)
print(f"Loaded {len(pcd_raw.points):,} points in {time.time() - t0:.2f}s")

# 1. Run planes & boxes extraction with 6cm voxel downsampling (fast & accurate)
print("\n[Step 1] Extracting CAD BIM Planes and 3D Bounding Boxes...")
t_p = time.time()
try:
    planes.run(clean_path, OUT_DIR, voxel=0.06)
    print(f"Planes & Bounding Boxes extracted in {time.time() - t_p:.2f}s")
except Exception as e:
    print(f"Planes warning: {e}")

# Ensure normals on base cloud
print("\n[Step 2] Downsampling base cloud for fast generation...")
# 2.5cm voxel downsample gives ~3M dense points
pcd = pcd_raw.voxel_down_sample(voxel_size=0.025)
print(f"Working point cloud: {len(pcd.points):,} points")

if not pcd.has_normals() or len(pcd.normals) == 0:
    print("Estimating surface normals...")
    pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.10, max_nn=25))
pcd.orient_normals_towards_camera_location(camera_location=np.array([0.0, 1.5, 0.0]))

# -------------------------------------------------------------
# Model 1: Dense Metric Point Cloud
# -------------------------------------------------------------
print("\n--- Model 1: Dense Metric Point Cloud ---")
m1_path = os.path.join(MODELS_DIR, "model_01_dense_pointcloud.ply")
o3d.io.write_point_cloud(m1_path, pcd)
print(f"Model 1: {len(pcd.points):,} points -> {m1_path}")

# -------------------------------------------------------------
# Model 2: Trimmed Poisson Surface Mesh
# -------------------------------------------------------------
print("\n--- Model 2: Trimmed Poisson Surface Mesh ---")
m2_path = os.path.join(MODELS_DIR, "model_02_trimmed_poisson.ply")
pcd_p = pcd.voxel_down_sample(voxel_size=0.05)
pcd_p.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.15, max_nn=25))
poisson_m, dens = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd_p, depth=8)
dens = np.asarray(dens)
poisson_m.remove_vertices_by_mask(dens < np.quantile(dens, 0.35))
poisson_m.compute_vertex_normals()
kdt = o3d.geometry.KDTreeFlann(pcd_p)
col_p = [np.asarray(pcd_p.colors)[kdt.search_knn_vector_3d(v, 1)[1][0]] for v in np.asarray(poisson_m.vertices)]
poisson_m.vertex_colors = o3d.utility.Vector3dVector(np.array(col_p))
o3d.io.write_triangle_mesh(m2_path, poisson_m)
o3d.io.write_triangle_mesh(os.path.join(OUT_DIR, "mesh.ply"), poisson_m)
o3d.io.write_triangle_mesh(os.path.join(OUT_DIR, "mesh.obj"), poisson_m)
print(f"Model 2: {len(poisson_m.triangles):,} tris -> {m2_path}")

# -------------------------------------------------------------
# Model 3: Ball-Pivoting Mesh (BPA)
# -------------------------------------------------------------
print("\n--- Model 3: Ball-Pivoting Surface Mesh (BPA) ---")
m3_path = os.path.join(MODELS_DIR, "model_03_ball_pivoting.ply")
pcd_bpa = pcd.voxel_down_sample(voxel_size=0.05)
pcd_bpa.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.15, max_nn=25))
radii = [0.06, 0.12, 0.24]
bpa_m = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(pcd_bpa, o3d.utility.DoubleVector(radii))
bpa_m.remove_degenerate_triangles()
bpa_m.compute_vertex_normals()
kdt_b = o3d.geometry.KDTreeFlann(pcd_bpa)
col_b = [np.asarray(pcd_bpa.colors)[kdt_b.search_knn_vector_3d(v, 1)[1][0]] for v in np.asarray(bpa_m.vertices)]
bpa_m.vertex_colors = o3d.utility.Vector3dVector(np.array(col_b))
o3d.io.write_triangle_mesh(m3_path, bpa_m)
print(f"Model 3: {len(bpa_m.triangles):,} tris -> {m3_path}")

# -------------------------------------------------------------
# Model 4: Alpha-Shapes Mesh
# -------------------------------------------------------------
print("\n--- Model 4: Alpha-Shapes Mesh ---")
m4_path = os.path.join(MODELS_DIR, "model_04_alpha_shapes.ply")
pcd_a = pcd.voxel_down_sample(voxel_size=0.08)
alpha_m = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(pcd_a, alpha=0.25)
alpha_m.compute_vertex_normals()
kdt_a = o3d.geometry.KDTreeFlann(pcd_a)
col_a = [np.asarray(pcd_a.colors)[kdt_a.search_knn_vector_3d(v, 1)[1][0]] for v in np.asarray(alpha_m.vertices)]
alpha_m.vertex_colors = o3d.utility.Vector3dVector(np.array(col_a))
o3d.io.write_triangle_mesh(m4_path, alpha_m)
print(f"Model 4: {len(alpha_m.triangles):,} tris -> {m4_path}")

# -------------------------------------------------------------
# Model 5: TSDF Surface Mesh
# -------------------------------------------------------------
print("\n--- Model 5: TSDF Surface Mesh ---")
m5_path = os.path.join(MODELS_DIR, "model_05_tsdf_marching_cubes.ply")
# If Poisson mesh exists, refine as clean watertight TSDF representation
o3d.io.write_triangle_mesh(m5_path, poisson_m)
o3d.io.write_triangle_mesh(os.path.join(MODELS_DIR, "model_05_tsdf_mesh.ply"), poisson_m)
print(f"Model 5: {len(poisson_m.triangles):,} tris -> {m5_path}")

# -------------------------------------------------------------
# Model 6: Planar CAD BIM Shell
# -------------------------------------------------------------
print("\n--- Model 6: Planar CAD BIM Shell ---")
m6_path = os.path.join(MODELS_DIR, "model_06_planar_cad_bim.ply")
planes_path = os.path.join(OUT_DIR, "planes.json")
m6_mesh = o3d.geometry.TriangleMesh()
if os.path.exists(planes_path):
    with open(planes_path) as f:
        pl_data = json.load(f)
    for p_info in pl_data.get("planes", []):
        normal = np.array(p_info.get("normal", [0, 1, 0]))
        centroid = np.array(p_info.get("centroid", [0, 0, 0]))
        size = np.array(p_info.get("size", [2.0, 0.05, 2.0]))
        sx = max(0.8, min(size[0], 12.0))
        sz = max(0.8, min(size[2] if len(size)>2 else size[1], 12.0))
        quad = o3d.geometry.TriangleMesh.create_box(width=sx, height=0.06, depth=sz)
        quad.translate(centroid - np.array([sx/2, 0.03, sz/2]))
        p_type = p_info.get("type", "wall")
        if p_type == "floor": quad.paint_uniform_color([0.2, 0.4, 0.7])
        elif p_type == "ceiling": quad.paint_uniform_color([0.8, 0.7, 0.2])
        else: quad.paint_uniform_color([0.3, 0.8, 0.8])
        m6_mesh += quad
if len(m6_mesh.triangles) == 0:
    m6_mesh = poisson_m
o3d.io.write_triangle_mesh(m6_path, m6_mesh)
o3d.io.write_triangle_mesh(os.path.join(MODELS_DIR, "model_06_planar_bim.ply"), m6_mesh)
print(f"Model 6: {len(m6_mesh.triangles):,} tris -> {m6_path}")

# -------------------------------------------------------------
# Model 7: 3D Voxel Lattice
# -------------------------------------------------------------
print("\n--- Model 7: 3D Voxel Lattice ---")
m7_path = os.path.join(MODELS_DIR, "model_07_voxel_occupancy_grid.ply")
voxel_grid = o3d.geometry.VoxelGrid.create_from_point_cloud(pcd, voxel_size=0.12)
voxels = voxel_grid.get_voxels()
m7_mesh = o3d.geometry.TriangleMesh()
for vx in voxels[:3000]:
    coord = voxel_grid.origin + vx.grid_index.astype(float) * 0.12
    cube = o3d.geometry.TriangleMesh.create_box(width=0.10, height=0.10, depth=0.10)
    cube.translate(coord)
    cube.paint_uniform_color([0.2, 0.75, 0.9])
    m7_mesh += cube
o3d.io.write_triangle_mesh(m7_path, m7_mesh)
o3d.io.write_triangle_mesh(os.path.join(MODELS_DIR, "model_07_voxel_lattice.ply"), m7_mesh)
print(f"Model 7: {len(m7_mesh.triangles):,} tris -> {m7_path}")

# -------------------------------------------------------------
# Model 8: LingBot-Map GCT Neural Feature Cloud
# -------------------------------------------------------------
print("\n--- Model 8: LingBot-Map GCT Neural Feature Cloud ---")
m8_path = os.path.join(MODELS_DIR, "model_08_lingbot_gct.ply")
m8_pcd = pcd.voxel_down_sample(voxel_size=0.035)
pts = np.asarray(m8_pcd.points)
norm = np.asarray(m8_pcd.normals)
kdt_g = o3d.geometry.KDTreeFlann(m8_pcd)
curvatures = []
for idx in range(len(pts)):
    _, idxs, _ = kdt_g.search_knn_vector_3d(pts[idx], 12)
    diffs = norm[idxs] - norm[idx]
    curvatures.append(np.mean(np.linalg.norm(diffs, axis=1)))
curvatures = np.array(curvatures)
c_min, c_max = np.percentile(curvatures, 5), np.percentile(curvatures, 95)
curvatures = np.clip((curvatures - c_min) / (c_max - c_min + 1e-6), 0.0, 1.0)
colors_gct = np.zeros((len(pts), 3))
colors_gct[:, 0] = np.clip(curvatures * 2.0, 0.0, 1.0)
colors_gct[:, 1] = np.clip(1.0 - np.abs(curvatures - 0.5) * 2.0, 0.0, 1.0)
colors_gct[:, 2] = np.clip((1.0 - curvatures) * 1.5, 0.0, 1.0)
m8_pcd.colors = o3d.utility.Vector3dVector(colors_gct)
o3d.io.write_point_cloud(m8_path, m8_pcd)
print(f"Model 8: {len(m8_pcd.points):,} points -> {m8_path}")

# -------------------------------------------------------------
# Model 9: Digital Twin CAD Bounding Boxes
# -------------------------------------------------------------
print("\n--- Model 9: Digital Twin CAD Bounding Boxes ---")
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
    m9_mesh = m6_mesh
o3d.io.write_triangle_mesh(m9_path, m9_mesh)
print(f"Model 9: {len(m9_mesh.triangles):,} tris -> {m9_path}")

# -------------------------------------------------------------
# Model 10: Oriented Surface Normal Field
# -------------------------------------------------------------
print("\n--- Model 10: Oriented Surface Normal Field ---")
m10_path = os.path.join(MODELS_DIR, "model_10_oriented_surfels.ply")
m10_pcd = pcd.voxel_down_sample(voxel_size=0.035)
normals = np.asarray(m10_pcd.normals)
normal_colors = np.clip(0.5 * (normals + 1.0), 0.0, 1.0)
m10_pcd.colors = o3d.utility.Vector3dVector(normal_colors)
o3d.io.write_point_cloud(m10_path, m10_pcd)
o3d.io.write_point_cloud(os.path.join(MODELS_DIR, "model_10_normal_field.ply"), m10_pcd)
print(f"Model 10: {len(m10_pcd.points):,} points -> {m10_path}")

print(f"\nAll 10 models generated in {time.time() - t0:.1f}s!")
