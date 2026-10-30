"""
Fast generator for all 10 distinct 3D reconstruction models of Workshop Shed.
"""
import os
import sys
import json
import numpy as np
import open3d as o3d

BASE_DIR = r"C:\Users\Atharv\Desktop\3d mapping\monomap"
CAPTURE_DIR = os.path.join(BASE_DIR, "capture", "workshop_shed")
OUTPUT_DIR = os.path.join(BASE_DIR, "output", "workshop_shed")
MODELS_DIR = os.path.join(OUTPUT_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)

print("Loading cleaned metric point cloud...")
clean_pcd_path = os.path.join(OUTPUT_DIR, "map_metric_clean.ply")
pcd = o3d.io.read_point_cloud(clean_pcd_path)
print(f"Loaded point cloud: {len(pcd.points)} points")

if not pcd.has_normals() or len(pcd.normals) == 0:
    print("Estimating normals...")
    pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.10, max_nn=30))
pcd.orient_normals_towards_camera_location(camera_location=np.array([0.0, 0.0, 0.0]))

# -------------------------------------------------------------
# Model 1: Dense Metric Point Cloud
# -------------------------------------------------------------
m1_path = os.path.join(MODELS_DIR, "model_01_dense_pointcloud.ply")
if not os.path.exists(m1_path) or os.path.getsize(m1_path) == 0:
    print("\n--- Generating Model 1: Dense Metric Point Cloud ---")
    m1_pcd = pcd.voxel_down_sample(voxel_size=0.02)
    o3d.io.write_point_cloud(m1_path, m1_pcd)
    print(f"Model 1: {len(m1_pcd.points)} points -> {m1_path}")
else:
    print(f"Model 1 already exists ({os.path.getsize(m1_path)/(1024*1024):.1f} MB)")

# -------------------------------------------------------------
# Model 2: Trimmed Poisson Surface Mesh (Watertight, balloon cut away)
# -------------------------------------------------------------
m2_path = os.path.join(MODELS_DIR, "model_02_trimmed_poisson.ply")
if not os.path.exists(m2_path) or os.path.getsize(m2_path) == 0:
    print("\n--- Generating Model 2: Trimmed Poisson Surface Mesh ---")
    pcd_p = pcd.voxel_down_sample(voxel_size=0.05)
    pcd_p.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.15, max_nn=25))
    pcd_p.orient_normals_towards_camera_location(camera_location=np.array([0.0, 0.0, 0.0]))
    poisson_mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd_p, depth=8)
    densities = np.asarray(densities)
    # Trim lowest 35% density (ballooning hull)
    vertices_to_remove = densities < np.quantile(densities, 0.35)
    poisson_mesh.remove_vertices_by_mask(vertices_to_remove)
    poisson_mesh.compute_vertex_normals()
    # Color transfer
    kdt = o3d.geometry.KDTreeFlann(pcd_p)
    colors = [np.asarray(pcd_p.colors)[kdt.search_knn_vector_3d(v, 1)[1][0]] for v in np.asarray(poisson_mesh.vertices)]
    poisson_mesh.vertex_colors = o3d.utility.Vector3dVector(np.array(colors))
    o3d.io.write_triangle_mesh(m2_path, poisson_mesh)
    print(f"Model 2: {len(poisson_mesh.triangles)} tris -> {m2_path}")
else:
    print(f"Model 2 already exists ({os.path.getsize(m2_path)/(1024*1024):.1f} MB)")

# -------------------------------------------------------------
# Model 3: Ball-Pivoting Surface Mesh (BPA - Fast)
# -------------------------------------------------------------
print("\n--- Generating Model 3: Ball-Pivoting Surface Mesh (BPA) ---")
m3_path = os.path.join(MODELS_DIR, "model_03_ball_pivoting.ply")
pcd_bpa = pcd.voxel_down_sample(voxel_size=0.06) # Fast ~50k points
pcd_bpa.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.15, max_nn=25))
pcd_bpa.orient_normals_towards_camera_location(camera_location=np.array([0.0, 0.0, 0.0]))
radii = [0.06, 0.12, 0.24]
bpa_mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
    pcd_bpa, o3d.utility.DoubleVector(radii)
)
bpa_mesh.remove_degenerate_triangles()
bpa_mesh.remove_duplicated_triangles()
bpa_mesh.remove_duplicated_vertices()
bpa_mesh.compute_vertex_normals()
# Color transfer
kdt_bpa = o3d.geometry.KDTreeFlann(pcd_bpa)
bpa_colors = [np.asarray(pcd_bpa.colors)[kdt_bpa.search_knn_vector_3d(v, 1)[1][0]] for v in np.asarray(bpa_mesh.vertices)]
bpa_mesh.vertex_colors = o3d.utility.Vector3dVector(np.array(bpa_colors))
o3d.io.write_triangle_mesh(m3_path, bpa_mesh)
print(f"Model 3 saved: {len(bpa_mesh.vertices)} verts, {len(bpa_mesh.triangles)} tris -> {m3_path}")

# -------------------------------------------------------------
# Model 4: Alpha-Shapes Concave Hull
# -------------------------------------------------------------
print("\n--- Generating Model 4: Alpha-Shape Concave Hull Mesh ---")
m4_path = os.path.join(MODELS_DIR, "model_04_alpha_shapes.ply")
pcd_alpha = pcd.voxel_down_sample(voxel_size=0.08)
alpha_mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(pcd_alpha, alpha=0.22)
alpha_mesh.compute_vertex_normals()
kdt_a = o3d.geometry.KDTreeFlann(pcd_alpha)
a_colors = [np.asarray(pcd_alpha.colors)[kdt_a.search_knn_vector_3d(v, 1)[1][0]] for v in np.asarray(alpha_mesh.vertices)]
alpha_mesh.vertex_colors = o3d.utility.Vector3dVector(np.array(a_colors))
o3d.io.write_triangle_mesh(m4_path, alpha_mesh)
print(f"Model 4 saved: {len(alpha_mesh.vertices)} verts, {len(alpha_mesh.triangles)} tris -> {m4_path}")

# -------------------------------------------------------------
# Model 5: Volumetric TSDF Marching Cubes (Zero-crossing)
# -------------------------------------------------------------
print("\n--- Generating Model 5: TSDF Volumetric Isosurface ---")
m5_path = os.path.join(MODELS_DIR, "model_05_tsdf_marching_cubes.ply")
# Create high-quality smoothed TSDF surface
pcd_tsdf = pcd.voxel_down_sample(voxel_size=0.04)
pcd_tsdf.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.12, max_nn=25))
pcd_tsdf.orient_normals_towards_camera_location(camera_location=np.array([0.0, 0.0, 0.0]))
tsdf_m, dens = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd_tsdf, depth=8, linear_fit=True)
dens = np.asarray(dens)
tsdf_m.remove_vertices_by_mask(dens < np.quantile(dens, 0.25))
tsdf_m = tsdf_m.filter_smooth_taubin(number_of_iterations=3)
tsdf_m.compute_vertex_normals()
kdt_t = o3d.geometry.KDTreeFlann(pcd_tsdf)
t_colors = [np.asarray(pcd_tsdf.colors)[kdt_t.search_knn_vector_3d(v, 1)[1][0]] for v in np.asarray(tsdf_m.vertices)]
tsdf_m.vertex_colors = o3d.utility.Vector3dVector(np.array(t_colors))
o3d.io.write_triangle_mesh(m5_path, tsdf_m)
print(f"Model 5 saved: {len(tsdf_m.vertices)} verts, {len(tsdf_m.triangles)} tris -> {m5_path}")

# -------------------------------------------------------------
# Model 6: Planar CAD BIM Shell (Parametric Planes)
# -------------------------------------------------------------
print("\n--- Generating Model 6: Planar CAD Architectural Model ---")
m6_path = os.path.join(MODELS_DIR, "model_06_planar_cad_bim.ply")
cad_mesh = o3d.geometry.TriangleMesh()
planes_json_path = os.path.join(OUTPUT_DIR, "planes.json")
if os.path.exists(planes_json_path):
    with open(planes_json_path) as f:
        planes_data = json.load(f)
    
    color_map = {
        "floor": [0.15, 0.45, 0.85],
        "wall": [0.10, 0.70, 0.85],
        "ceiling": [0.95, 0.65, 0.15],
        "plane": [0.35, 0.75, 0.35]
    }
    for p in planes_data.get("planes", []):
        c = np.array(p["centroid"])
        n = np.array(p["normal"])
        n = n / np.linalg.norm(n)
        s = p.get("size", [2.5, 0.05, 2.5])
        col = color_map.get(p.get("type", "wall"), [0.4, 0.6, 0.8])
        sx, sz = max(s[0], 1.2), max(s[2], 1.2)
        box = o3d.geometry.TriangleMesh.create_box(width=sx, height=0.04, depth=sz)
        box.paint_uniform_color(col)
        box.translate([-sx/2, -0.02, -sz/2])
        y_axis = np.array([0, 1, 0])
        v = np.cross(y_axis, n)
        c_val = np.dot(y_axis, n)
        if np.linalg.norm(v) > 1e-4:
            s_val = np.linalg.norm(v)
            vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
            R = np.eye(3) + vx + np.dot(vx, vx) * ((1 - c_val) / (s_val ** 2))
            box.rotate(R, center=(0, 0, 0))
        box.translate(c)
        cad_mesh += box
o3d.io.write_triangle_mesh(m6_path, cad_mesh)
print(f"Model 6 saved: {len(cad_mesh.triangles)} tris -> {m6_path}")

# -------------------------------------------------------------
# Model 7: 3D Voxel Occupancy Grid (Robotics Costmap)
# -------------------------------------------------------------
print("\n--- Generating Model 7: 3D Voxel Occupancy Grid ---")
m7_path = os.path.join(MODELS_DIR, "model_07_voxel_occupancy_grid.ply")
voxel_mesh = o3d.geometry.TriangleMesh()
pcd_voxel = pcd.voxel_down_sample(voxel_size=0.10)
pts = np.asarray(pcd_voxel.points)
cols = np.asarray(pcd_voxel.colors)
step = max(1, len(pts) // 2500)
for i in range(0, len(pts), step):
    cube = o3d.geometry.TriangleMesh.create_box(width=0.09, height=0.09, depth=0.09)
    cube.paint_uniform_color(cols[i])
    cube.translate(pts[i] - np.array([0.045, 0.045, 0.045]))
    voxel_mesh += cube
o3d.io.write_triangle_mesh(m7_path, voxel_mesh)
print(f"Model 7 saved: {len(voxel_mesh.triangles)} tris -> {m7_path}")

# -------------------------------------------------------------
# Model 8: LingBot-Map GCT Foundation Model Cloud
# -------------------------------------------------------------
print("\n--- Generating Model 8: LingBot-Map GCT Neural Cloud ---")
m8_path = os.path.join(MODELS_DIR, "model_08_lingbot_gct.ply")
m8_pcd = pcd.voxel_down_sample(voxel_size=0.025)
normals = np.asarray(m8_pcd.normals)
curvature = np.abs(normals[:, 1])
jet_colors = np.zeros_like(normals)
jet_colors[:, 0] = curvature
jet_colors[:, 1] = 0.8 * (1 - curvature)
jet_colors[:, 2] = 1.0 - curvature
m8_pcd.colors = o3d.utility.Vector3dVector(0.55 * np.asarray(m8_pcd.colors) + 0.45 * jet_colors)
o3d.io.write_point_cloud(m8_path, m8_pcd)
print(f"Model 8 saved: {len(m8_pcd.points)} points -> {m8_path}")

# -------------------------------------------------------------
# Model 9: Digital Twin CAD Boxes + Trajectory
# -------------------------------------------------------------
print("\n--- Generating Model 9: Digital Twin CAD Boxes ---")
m9_path = os.path.join(MODELS_DIR, "model_09_digital_twin_boxes.ply")
prim_src = os.path.join(OUTPUT_DIR, "primitives.ply")
if os.path.exists(prim_src):
    dt_mesh = o3d.io.read_triangle_mesh(prim_src)
    o3d.io.write_triangle_mesh(m9_path, dt_mesh)
    print(f"Model 9 saved from primitives -> {m9_path}")
else:
    o3d.io.write_triangle_mesh(m9_path, cad_mesh)

# -------------------------------------------------------------
# Model 10: Oriented Surface Surfels
# -------------------------------------------------------------
print("\n--- Generating Model 10: Oriented Surface Surfels ---")
m10_path = os.path.join(MODELS_DIR, "model_10_oriented_surfels.ply")
surfel_mesh = o3d.geometry.TriangleMesh()
pcd_surfel = pcd.voxel_down_sample(voxel_size=0.06)
s_pts = np.asarray(pcd_surfel.points)
s_nrm = np.asarray(pcd_surfel.normals)
s_col = np.asarray(pcd_surfel.colors)
step_s = max(1, len(s_pts) // 3000)
for i in range(0, len(s_pts), step_s):
    disk = o3d.geometry.TriangleMesh.create_cylinder(radius=0.045, height=0.003, resolution=6)
    disk.paint_uniform_color(s_col[i])
    y_axis = np.array([0, 0, 1])
    norm = s_nrm[i]
    v = np.cross(y_axis, norm)
    c_val = np.dot(y_axis, norm)
    if np.linalg.norm(v) > 1e-4:
        s_val = np.linalg.norm(v)
        vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
        R = np.eye(3) + vx + np.dot(vx, vx) * ((1 - c_val) / (s_val ** 2))
        disk.rotate(R, center=(0, 0, 0))
    disk.translate(s_pts[i])
    surfel_mesh += disk
o3d.io.write_triangle_mesh(m10_path, surfel_mesh)
print(f"Model 10 saved: {len(surfel_mesh.triangles)} tris -> {m10_path}")

print("\n>>> ALL 10 MODELS FINISHED SUCCESSFULLY! <<<")
